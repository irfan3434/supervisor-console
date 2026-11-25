import { useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useStore } from './store';

export function useTakeover(conversationId: string) {
  return useMutation({
    mutationFn: () => api.takeover(conversationId),
    // The server also emits a status event; applying the response makes the UI react even
    // while the stream is reconnecting. Both set the same value, so order does not matter.
    onSuccess: ({ conversation }) => useStore.getState().setStatus(conversationId, conversation.status),
  });
}

const newClientId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `cm-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Optimistic send: the bubble appears immediately (pending), is confirmed by the stream's
 * `message` event (matched on clientMessageId), and is rolled back with an error on failure.
 */
export function useSendMessage(conversationId: string) {
  return useMutation({
    mutationFn: (vars: { text: string; clientMessageId: string }) =>
      api.sendMessage(conversationId, vars.text, vars.clientMessageId),
    onMutate: ({ text, clientMessageId }) => useStore.getState().addPending(conversationId, clientMessageId, text),
    onSuccess: ({ message }, { clientMessageId }) =>
      useStore.getState().confirmPending(conversationId, clientMessageId, message.id),
    onError: (error, { text, clientMessageId }) =>
      useStore.getState().rollbackPending(conversationId, clientMessageId, text, error.message),
  });
}

export { newClientId };
