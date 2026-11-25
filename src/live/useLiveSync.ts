import { useEffect, useRef } from 'react';
import type { MessagesResponse } from '../types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, eventsUrl } from '../api/client';
import { EventStream } from './eventStream';
import { useStore, waitForCursor } from './store';

export const conversationsKey = ['conversations'] as const;
export const messagesKey = (id: string) => ['messages', id] as const;

/**
 * Boot sequence: GET /conversations → hydrate the store (sets the cursor) → open the stream
 * from that cursor. On a server reset, drop everything and run the sequence again.
 */
export function useLiveSync() {
  const queryClient = useQueryClient();
  const streamRef = useRef<EventStream | null>(null);

  const list = useQuery({ queryKey: conversationsKey, queryFn: api.conversations });

  useEffect(() => {
    const stream = new EventStream({
      url: eventsUrl,
      getCursor: () => useStore.getState().cursor,
      onEvent: (ev) => useStore.getState().applyEvent(ev),
      onState: (s) => useStore.getState().setConnection(s),
      onResyncNeeded: (reason) => {
        console.warn(`[stream] ${reason}; reloading all data`);
        useStore.getState().reset();
        void queryClient.resetQueries();
      },
    });
    streamRef.current = stream;
    return () => {
      stream.stop();
      streamRef.current = null;
    };
  }, [queryClient]);

  useEffect(() => {
    if (!list.data) return;
    const store = useStore.getState();
    if (store.cursor !== null) return; // already live; the stream keeps the list current
    store.hydrateList(list.data);
    streamRef.current?.start();
  }, [list.data]);

  return list;
}

/**
 * Load a thread snapshot and merge it into the live store at its watermark.
 *
 * The merge happens inside the queryFn, the moment the response arrives (not in an effect),
 * so it completes even if the user switched to another conversation meanwhile. The query cache
 * only keeps the snapshot's metadata; the messages live in the store.
 */
export function useThread(conversationId: string) {
  return useQuery({
    queryKey: messagesKey(conversationId),
    queryFn: async (): Promise<{ lastEventId: number; count: number }> => {
      // The snapshot must be merged against a known cursor, so wait for the list first.
      await waitForCursor();
      // Start buffering this conversation's events *before* the request leaves.
      useStore.getState().beginThreadLoad(conversationId);
      let res: MessagesResponse;
      try {
        res = await api.messages(conversationId);
      } catch (error) {
        useStore.getState().abortThreadLoad(conversationId); // stop buffering
        throw error;
      }
      const result = useStore.getState().hydrateThread(conversationId, res);
      // Older than the stream position we requested at: only after a server restart. Retry.
      if (result === 'stale') {
        useStore.getState().abortThreadLoad(conversationId);
        throw new Error('Snapshot is older than the live stream');
      }
      return { lastEventId: res.lastEventId, count: res.messages.length };
    },
  });
}
