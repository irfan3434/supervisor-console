import type { Conversation, ConversationsResponse, Message, MessagesResponse } from '../types';

export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export const api = {
  conversations: () => request<ConversationsResponse>('/conversations'),
  messages: (conversationId: string) =>
    request<MessagesResponse>(`/conversations/${encodeURIComponent(conversationId)}/messages`),
  takeover: (conversationId: string) =>
    request<{ conversation: Conversation }>(`/conversations/${encodeURIComponent(conversationId)}/takeover`, {
      method: 'POST',
    }),
  sendMessage: (conversationId: string, text: string, clientMessageId: string) =>
    request<{ message: Message }>(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, clientMessageId }),
    }),
};

export const eventsUrl = (since: number) => `${API_URL}/events?since=${since}`;
