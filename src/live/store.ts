import { create } from 'zustand';
import type { ConversationsResponse, MessagesResponse, Status, StreamEvent } from '../types';
import * as R from './reducer';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting';
export type Direction = 'ltr' | 'rtl';

export interface SendError {
  clientMessageId: string;
  text: string;
  error: string;
}

interface UiState {
  connection: ConnectionState;
  reconnects: number;
  dir: Direction;
  /** Rolled-back sends per conversation, shown with Retry / Edit / Dismiss. */
  sendErrors: Record<string, SendError[]>;
}

export interface Store extends R.LiveState, UiState {
  hydrateList(res: ConversationsResponse): void;
  beginThreadLoad(conversationId: string): void;
  abortThreadLoad(conversationId: string): void;
  hydrateThread(conversationId: string, res: MessagesResponse): R.HydrateResult;
  applyEvent(ev: StreamEvent): R.ApplyResult;
  select(conversationId: string | null): void;
  setStatus(conversationId: string, status: Status): void;
  addPending(conversationId: string, clientMessageId: string, text: string): void;
  confirmPending(conversationId: string, clientMessageId: string, messageId: string): void;
  rollbackPending(conversationId: string, clientMessageId: string, text: string, error: string): void;
  clearSendError(conversationId: string, clientMessageId: string): void;
  setConnection(state: ConnectionState): void;
  setDir(dir: Direction): void;
  /** Drop all live data (keeps UI prefs and the selection) — used for a full resync. */
  reset(): void;
}

const savedDir = (): Direction => {
  try {
    return localStorage.getItem('dir') === 'rtl' ? 'rtl' : 'ltr';
  } catch {
    return 'ltr';
  }
};

const live = (s: Store): R.LiveState => ({
  cursor: s.cursor,
  conversations: s.conversations,
  threads: s.threads,
  pending: s.pending,
  selectedId: s.selectedId,
});

export const useStore = create<Store>()((set, get) => {
  /** Run a pure reducer step against the live slice of the store. */
  const step = (fn: (s: R.LiveState) => R.LiveState) => set((s) => fn(live(s)));

  return {
    ...R.initialLiveState,
    connection: 'idle',
    reconnects: 0,
    dir: typeof localStorage === 'undefined' ? 'ltr' : savedDir(),
    sendErrors: {},

    hydrateList: (res) => step((s) => R.hydrateList(s, res)),
    beginThreadLoad: (id) => step((s) => R.beginThreadLoad(s, id)),
    abortThreadLoad: (id) => step((s) => R.abortThreadLoad(s, id)),
    hydrateThread: (id, res) => {
      const { state, result } = R.hydrateThread(live(get()), id, res);
      if (result === 'hydrated') set(state);
      return result;
    },
    applyEvent: (ev) => {
      const { state, result } = R.applyEvent(live(get()), ev);
      if (result === 'applied') {
        set(state);
        // A send that looked failed (e.g. network error) but reached the server: drop its error.
        if (ev.type === 'message' && ev.message.clientMessageId) {
          get().clearSendError(ev.conversationId, ev.message.clientMessageId);
        }
      }
      return result;
    },
    select: (id) => step((s) => R.selectConversation(s, id)),
    setStatus: (id, status) => step((s) => R.setStatus(s, id, status)),
    addPending: (conversationId, clientMessageId, text) => {
      step((s) => R.addPending(s, { conversationId, clientMessageId, text }));
      get().clearSendError(conversationId, clientMessageId); // a retry replaces its own error
    },
    confirmPending: (id, cmid, messageId) => step((s) => R.confirmPending(s, id, cmid, messageId)),
    rollbackPending: (id, cmid, text, error) => {
      step((s) => R.removePending(s, id, cmid));
      // The request failed on our side but the stream already shows the message: no error.
      if (R.hasDelivered(live(get()), id, cmid)) return;
      set((s) => ({
        sendErrors: { ...s.sendErrors, [id]: [...(s.sendErrors[id] ?? []), { clientMessageId: cmid, text, error }] },
      }));
    },
    clearSendError: (id, cmid) =>
      set((s) => {
        const list = s.sendErrors[id];
        if (!list?.some((e) => e.clientMessageId === cmid)) return s;
        return { sendErrors: { ...s.sendErrors, [id]: list.filter((e) => e.clientMessageId !== cmid) } };
      }),
    setConnection: (connection) =>
      set((s) => ({
        connection,
        reconnects: connection === 'reconnecting' && s.connection !== 'reconnecting' ? s.reconnects + 1 : s.reconnects,
      })),
    setDir: (dir) => {
      try {
        localStorage.setItem('dir', dir);
      } catch {
        /* ignore */
      }
      set({ dir });
    },
    reset: () =>
      set((s) => ({ ...R.initialLiveState, selectedId: s.selectedId, pending: {}, sendErrors: {} })),
  };
});

/** Resolves once the conversation list has been hydrated (the global cursor exists). */
export function waitForCursor(): Promise<number> {
  const current = useStore.getState().cursor;
  if (current !== null) return Promise.resolve(current);
  return new Promise((resolve) => {
    const unsub = useStore.subscribe((s) => {
      if (s.cursor !== null) {
        unsub();
        resolve(s.cursor);
      }
    });
  });
}

// Dev only: inspect the live store from the browser console via `__store.getState()`.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __store: typeof useStore }).__store = useStore;
}
