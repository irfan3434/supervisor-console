/**
 * Pure state machine for everything live: stream events, REST snapshots merged in at their
 * watermark, and optimistic sends. No React, no I/O — the Zustand store wraps it and the
 * unit tests drive it directly.
 *
 * Two watermarks keep the state free of gaps and duplicates:
 *
 *  - `cursor` (global): id of the last stream event processed. Event ids go up by exactly one
 *    across the whole stream, so `id <= cursor` is a replayed duplicate (ignored) and
 *    `id > cursor + 1` is a gap (not applied; the caller reconnects from `cursor`).
 *
 *  - `thread.snapshotId` (per conversation): a message snapshot is fetched later than the list,
 *    so it already contains some events the stream is still going to deliver. Thread-level
 *    changes from events with `id <= snapshotId` are skipped. While a snapshot is in flight,
 *    events for that conversation are buffered and replayed on top of it once it arrives.
 */
import type { ConversationsResponse, Message, MessagesResponse, Role, Status, StreamEvent } from '../types';

export interface Draft {
  messageId: string;
  text: string;
  /** true when we joined mid-reply (missed message_start), so `text` lacks the beginning. */
  partial: boolean;
}

export interface ConversationLive {
  id: string;
  customer: string;
  status: Status;
  lastMessage: string;
  /** AI reply currently streaming in this conversation (for the list preview). */
  draft: Draft | null;
  /** Mirror of the server's unread counter (it counts customer messages). */
  serverUnread: number;
  /** How much of `serverUnread` the supervisor has already seen. Unread = server - seen. */
  seenUnread: number;
  /** Reason from the last transfer_to_human tool call we saw (REST does not return it). */
  handoffReason: string | null;
  /** Id of that tool_call event, so the thread can show the note even if opened later. */
  handoffEventId: number | null;
  /** Sort key: id of the last event that touched the conversation; snapshot rank before that. */
  activity: number;
}

export interface MessageItem {
  kind: 'message';
  id: string;
  role: Role;
  text: string;
  createdAt: string | null;
  streaming: boolean;
  clientMessageId?: string;
}

export interface HandoffItem {
  kind: 'handoff';
  id: string;
  reason: string;
  eventId: number;
}

export type ThreadItem = MessageItem | HandoffItem;

export interface ThreadLive {
  phase: 'loading' | 'ready';
  /** Events with id <= snapshotId are already contained in the snapshot. */
  snapshotId: number;
  /** Global cursor when the snapshot request was sent; the snapshot must be at least this new. */
  requestedAt: number;
  /** A snapshot has been merged at least once (snapshotId can legitimately be 0). */
  hasSnapshot: boolean;
  ids: string[];
  items: Record<string, ThreadItem>;
  /** Events received while the snapshot request was in flight. */
  buffer: StreamEvent[];
}

export interface PendingSend {
  clientMessageId: string;
  conversationId: string;
  text: string;
  state: 'sending' | 'sent';
  /** Server id once the POST returned 201. */
  messageId: string | null;
}

export interface LiveState {
  /** Last processed stream event id; null until the conversation list is loaded. */
  cursor: number | null;
  conversations: Record<string, ConversationLive>;
  threads: Record<string, ThreadLive>;
  pending: Record<string, PendingSend[]>;
  selectedId: string | null;
}

export type ApplyResult = 'applied' | 'duplicate' | 'gap' | 'not_ready';

export const initialLiveState: LiveState = {
  cursor: null,
  conversations: {},
  threads: {},
  pending: {},
  selectedId: null,
};

// ---- Snapshots -----------------------------------------------------------------------------

/** Seed (or re-seed after a resync) from GET /conversations. Sets the global cursor. */
export function hydrateList(state: LiveState, res: ConversationsResponse): LiveState {
  const conversations: Record<string, ConversationLive> = {};
  res.conversations.forEach((c, index) => {
    const prev = state.conversations[c.id];
    const selected = state.selectedId === c.id;
    conversations[c.id] = {
      id: c.id,
      customer: c.customer,
      status: c.status,
      lastMessage: c.lastMessage,
      draft: null,
      serverUnread: c.unread,
      seenUnread: selected ? c.unread : Math.min(prev?.seenUnread ?? 0, c.unread),
      handoffReason: c.status === 'needs_human' || c.status === 'human' ? (prev?.handoffReason ?? null) : null,
      handoffEventId: c.status === 'needs_human' || c.status === 'human' ? (prev?.handoffEventId ?? null) : null,
      // The list arrives newest first; live events use their (positive) id as the sort key.
      activity: -index,
    };
  });
  return { ...state, cursor: res.lastEventId, conversations };
}

/** Called right before GET /conversations/:id/messages is sent. */
export function beginThreadLoad(state: LiveState, conversationId: string): LiveState {
  const prev = state.threads[conversationId];
  const thread: ThreadLive = {
    phase: 'loading',
    snapshotId: prev?.snapshotId ?? 0,
    requestedAt: state.cursor ?? 0,
    hasSnapshot: prev?.hasSnapshot ?? false,
    // Keep showing what we had while a re-fetch is in flight.
    ids: prev?.ids ?? [],
    items: prev?.items ?? {},
    buffer: [],
  };
  return { ...state, threads: { ...state.threads, [conversationId]: thread } };
}

export type HydrateResult = 'hydrated' | 'stale' | 'ignored';

/** Merge a message snapshot, then replay events buffered while it was in flight. */
export function hydrateThread(
  state: LiveState,
  conversationId: string,
  res: MessagesResponse,
): { state: LiveState; result: HydrateResult } {
  const thread = state.threads[conversationId];
  if (!thread || thread.phase !== 'loading') return { state, result: 'ignored' };
  // The server's lastEventId is always >= any event we received before sending the request.
  // If it is older, the server was restarted (or a cached response was used): refetch.
  if (res.lastEventId < thread.requestedAt) return { state, result: 'stale' };

  const ids: string[] = [];
  const items: Record<string, ThreadItem> = {};
  for (const m of res.messages) {
    if (items[m.id]) continue;
    ids.push(m.id);
    items[m.id] = toItem(m);
  }
  // Hand-off notes are not part of the REST data; keep the ones we already showed.
  for (const id of thread.ids) {
    const item = thread.items[id];
    if (item?.kind === 'handoff' && item.eventId <= res.lastEventId && !items[id]) {
      insertHandoffInOrder(ids, items, item);
    }
  }

  let next: ThreadLive = {
    phase: 'ready',
    snapshotId: res.lastEventId,
    requestedAt: thread.requestedAt,
    hasSnapshot: true,
    ids,
    items,
    buffer: [],
  };
  // The thread was opened after the hand-off: the REST data has no trace of it, so add the note.
  const conv0 = state.conversations[conversationId];
  if (conv0?.handoffEventId != null && conv0.handoffReason && conv0.handoffEventId <= res.lastEventId) {
    const id = handoffId(conv0.handoffEventId);
    if (!items[id]) insertHandoffInOrder(ids, items, { kind: 'handoff', id, reason: conv0.handoffReason, eventId: conv0.handoffEventId });
  }
  for (const ev of thread.buffer) {
    if (ev.id > next.snapshotId || isThreadOnly(ev)) next = applyToThread(next, ev);
  }

  let nextState: LiveState = { ...state, threads: { ...state.threads, [conversationId]: next } };

  // Snapshot messages that carry one of our clientMessageIds confirm those pending sends.
  const confirmed = new Set(res.messages.map((m) => m.clientMessageId).filter(Boolean));
  nextState = filterPending(nextState, conversationId, (p) => !confirmed.has(p.clientMessageId) && !(p.messageId && items[p.messageId]));

  // If we joined a reply mid-stream, the snapshot has its beginning: repair the list preview.
  const conv = nextState.conversations[conversationId];
  if (conv?.draft?.partial) {
    const item = next.items[conv.draft.messageId];
    if (item?.kind === 'message') {
      nextState = patchConversation(nextState, conversationId, {
        draft: item.streaming ? { messageId: item.id, text: item.text, partial: false } : null,
        lastMessage: item.streaming ? conv.lastMessage : item.text,
      });
    }
  }
  return { state: nextState, result: 'hydrated' };
}

const handoffId = (eventId: number) => `handoff-${eventId}`;

/** Events whose effect on the thread is never part of a REST snapshot (deduplicated by id instead). */
const isThreadOnly = (ev: StreamEvent) => ev.type === 'tool_call';

/** The snapshot request failed: keep what we had and apply what was buffered, or forget the thread. */
export function abortThreadLoad(state: LiveState, conversationId: string): LiveState {
  const thread = state.threads[conversationId];
  if (!thread || thread.phase !== 'loading') return state;
  const threads = { ...state.threads };
  if (!thread.hasSnapshot) {
    delete threads[conversationId]; // nothing to show; the next load starts from scratch
  } else {
    let next: ThreadLive = { ...thread, phase: 'ready', buffer: [] };
    for (const ev of thread.buffer) if (ev.id > next.snapshotId || isThreadOnly(ev)) next = applyToThread(next, ev);
    threads[conversationId] = next;
  }
  return { ...state, threads };
}

function toItem(m: Message): MessageItem {
  return {
    kind: 'message',
    id: m.id,
    role: m.role,
    text: m.text,
    createdAt: m.createdAt,
    streaming: m.streaming === true,
    ...(m.clientMessageId ? { clientMessageId: m.clientMessageId } : {}),
  };
}

function insertHandoffInOrder(ids: string[], items: Record<string, ThreadItem>, item: HandoffItem) {
  // Without timestamps the best position is "after everything in the snapshot".
  ids.push(item.id);
  items[item.id] = item;
}

// ---- Stream events -------------------------------------------------------------------------

export function applyEvent(state: LiveState, ev: StreamEvent): { state: LiveState; result: ApplyResult } {
  if (state.cursor === null) return { state, result: 'not_ready' };
  if (ev.id <= state.cursor) return { state, result: 'duplicate' };
  if (ev.id > state.cursor + 1) return { state, result: 'gap' };

  let next = routeToThread(state, ev); // thread first: message_end reads the thread's full text
  next = applyToList(next, ev);
  next = reconcilePending(next, ev);
  return { state: { ...next, cursor: ev.id }, result: 'applied' };
}

function routeToThread(state: LiveState, ev: StreamEvent): LiveState {
  const thread = state.threads[ev.conversationId];
  if (!thread) return state; // not opened yet; its snapshot will include this event
  let next: ThreadLive;
  if (thread.phase === 'loading') next = { ...thread, buffer: [...thread.buffer, ev] };
  else if (ev.id <= thread.snapshotId && !isThreadOnly(ev)) return state; // already inside the snapshot
  else next = applyToThread(thread, ev);
  if (next === thread) return state;
  return { ...state, threads: { ...state.threads, [ev.conversationId]: next } };
}

export function applyToThread(thread: ThreadLive, ev: StreamEvent): ThreadLive {
  switch (ev.type) {
    case 'message': {
      if (thread.items[ev.message.id]) return thread;
      return addItem(thread, toItem(ev.message));
    }
    case 'message_start': {
      if (thread.items[ev.messageId]) return thread;
      return addItem(thread, { kind: 'message', id: ev.messageId, role: ev.role, text: '', createdAt: null, streaming: true });
    }
    case 'token': {
      const item = thread.items[ev.messageId];
      if (!item) {
        // Should not happen (message_start or the snapshot creates it); stay robust anyway.
        return addItem(thread, { kind: 'message', id: ev.messageId, role: 'ai', text: ev.text, createdAt: null, streaming: true });
      }
      if (item.kind !== 'message' || !item.streaming) return thread;
      return setItem(thread, { ...item, text: item.text + ev.text });
    }
    case 'message_end': {
      const item = thread.items[ev.messageId];
      if (!item || item.kind !== 'message' || !item.streaming) return thread;
      return setItem(thread, { ...item, streaming: false });
    }
    case 'tool_call': {
      const id = handoffId(ev.id);
      if (thread.items[id]) return thread;
      return addItem(thread, { kind: 'handoff', id, reason: ev.args.reason, eventId: ev.id });
    }
    case 'status':
      return thread;
  }
}

function addItem(thread: ThreadLive, item: ThreadItem): ThreadLive {
  return { ...thread, ids: [...thread.ids, item.id], items: { ...thread.items, [item.id]: item } };
}

function setItem(thread: ThreadLive, item: ThreadItem): ThreadLive {
  // `ids` keeps its identity, so the virtualised list does not re-render — only this row does.
  return { ...thread, items: { ...thread.items, [item.id]: item } };
}

function applyToList(state: LiveState, ev: StreamEvent): LiveState {
  const conv = state.conversations[ev.conversationId];
  if (!conv) return state;
  switch (ev.type) {
    case 'message': {
      const isCustomer = ev.message.role === 'customer';
      const selected = state.selectedId === conv.id;
      return patchConversation(state, conv.id, {
        lastMessage: ev.message.text,
        activity: ev.id,
        serverUnread: conv.serverUnread + (isCustomer ? 1 : 0),
        seenUnread: conv.seenUnread + (isCustomer && selected ? 1 : 0),
      });
    }
    case 'message_start':
      return patchConversation(state, conv.id, { draft: { messageId: ev.messageId, text: '', partial: false } });
    case 'token': {
      const draft: Draft =
        conv.draft?.messageId === ev.messageId
          ? { ...conv.draft, text: conv.draft.text + ev.text }
          : { messageId: ev.messageId, text: ev.text, partial: true };
      return patchConversation(state, conv.id, { draft });
    }
    case 'message_end': {
      const threadItem = state.threads[conv.id]?.items[ev.messageId];
      let text: string;
      if (threadItem?.kind === 'message' && state.threads[conv.id]?.phase === 'ready') text = threadItem.text;
      else if (conv.draft?.messageId === ev.messageId) text = conv.draft.partial ? `…${conv.draft.text}` : conv.draft.text;
      else text = conv.lastMessage;
      return patchConversation(state, conv.id, { lastMessage: text, draft: null, activity: ev.id });
    }
    case 'tool_call':
      return patchConversation(state, conv.id, { status: 'needs_human', handoffReason: ev.args.reason, handoffEventId: ev.id });
    case 'status':
      return patchConversation(state, conv.id, {
        status: ev.status,
        activity: ev.id,
        handoffReason: ev.status === 'needs_human' || ev.status === 'human' ? conv.handoffReason : null,
        handoffEventId: ev.status === 'needs_human' || ev.status === 'human' ? conv.handoffEventId : null,
      });
  }
}

function patchConversation(state: LiveState, id: string, patch: Partial<ConversationLive>): LiveState {
  const conv = state.conversations[id];
  if (!conv) return state;
  return { ...state, conversations: { ...state.conversations, [id]: { ...conv, ...patch } } };
}

// ---- Optimistic sends ----------------------------------------------------------------------

function reconcilePending(state: LiveState, ev: StreamEvent): LiveState {
  if (ev.type !== 'message' || ev.message.role !== 'human') return state;
  const { clientMessageId, id } = ev.message;
  return filterPending(state, ev.conversationId, (p) => p.clientMessageId !== clientMessageId && p.messageId !== id);
}

function filterPending(state: LiveState, conversationId: string, keep: (p: PendingSend) => boolean): LiveState {
  const list = state.pending[conversationId];
  if (!list?.length) return state;
  const filtered = list.filter(keep);
  if (filtered.length === list.length) return state;
  return { ...state, pending: { ...state.pending, [conversationId]: filtered } };
}

export function addPending(state: LiveState, p: Omit<PendingSend, 'state' | 'messageId'>): LiveState {
  const list = state.pending[p.conversationId] ?? [];
  const entry: PendingSend = { ...p, state: 'sending', messageId: null };
  return { ...state, pending: { ...state.pending, [p.conversationId]: [...list, entry] } };
}

/**
 * POST returned 201. The message is not inserted here: the stream will deliver it at its real
 * position (the HTTP response can overtake the stream, e.g. during a reconnect). Until then the
 * pending bubble stays, marked as sent. If the stream already delivered it, this is a no-op.
 */
export function confirmPending(state: LiveState, conversationId: string, clientMessageId: string, messageId: string): LiveState {
  const thread = state.threads[conversationId];
  if (thread?.items[messageId]) return removePending(state, conversationId, clientMessageId);
  const list = state.pending[conversationId];
  if (!list) return state;
  return {
    ...state,
    pending: {
      ...state.pending,
      [conversationId]: list.map((p) => (p.clientMessageId === clientMessageId ? { ...p, state: 'sent', messageId } : p)),
    },
  };
}

export function removePending(state: LiveState, conversationId: string, clientMessageId: string): LiveState {
  return filterPending(state, conversationId, (p) => p.clientMessageId !== clientMessageId);
}

/** True when the stream already delivered the message sent with this clientMessageId. */
export function hasDelivered(state: LiveState, conversationId: string, clientMessageId: string): boolean {
  const thread = state.threads[conversationId];
  if (!thread) return false;
  for (let i = thread.ids.length - 1, seen = 0; i >= 0 && seen < 200; i--, seen++) {
    const item = thread.items[thread.ids[i]!];
    if (item?.kind === 'message' && item.clientMessageId === clientMessageId) return true;
  }
  return false;
}

// ---- UI-driven -----------------------------------------------------------------------------

export function selectConversation(state: LiveState, id: string | null): LiveState {
  let next: LiveState = { ...state, selectedId: id };
  const conv = id ? state.conversations[id] : undefined;
  if (conv) next = patchConversation(next, conv.id, { seenUnread: conv.serverUnread });
  return next;
}

export function setStatus(state: LiveState, conversationId: string, status: Status): LiveState {
  return patchConversation(state, conversationId, { status });
}

// ---- Selectors -----------------------------------------------------------------------------

export const unreadOf = (c: ConversationLive) => Math.max(0, c.serverUnread - c.seenUnread);

export function sortedConversationIds(conversations: Record<string, ConversationLive>): string[] {
  return Object.values(conversations)
    .sort((a, b) => b.activity - a.activity)
    .map((c) => c.id);
}
