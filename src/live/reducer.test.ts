import { describe, expect, it } from 'vitest';
import type { ConversationsResponse, Message, StreamEvent } from '../types';
import {
  abortThreadLoad,
  addPending,
  applyEvent,
  beginThreadLoad,
  confirmPending,
  hasDelivered,
  hydrateList,
  hydrateThread,
  initialLiveState,
  selectConversation,
  sortedConversationIds,
  unreadOf,
  type LiveState,
  type MessageItem,
} from './reducer';

// ---- helpers -------------------------------------------------------------------------------

const list = (lastEventId: number): ConversationsResponse => ({
  lastEventId,
  conversations: [
    { id: 'c-1', customer: 'Sara', status: 'ai', lastMessage: 'hello', unread: 2, updatedAt: '2026-01-01T00:00:02Z' },
    { id: 'c-2', customer: 'محمد', status: 'ai', lastMessage: 'مرحبا', unread: 0, updatedAt: '2026-01-01T00:00:01Z' },
  ],
});

const msg = (id: string, role: Message['role'], text: string, extra: Partial<Message> = {}): Message => ({
  id,
  conversationId: 'c-1',
  role,
  text,
  createdAt: '2026-01-01T00:00:00Z',
  ...extra,
});

/** Feed events one by one, the way the SSE client does. */
function feed(state: LiveState, events: StreamEvent[]) {
  const results: string[] = [];
  for (const ev of events) {
    const r = applyEvent(state, ev);
    state = r.state;
    results.push(r.result);
  }
  return { state, results };
}

/** A typical AI reply in c-1: start, three tokens, end — ids from `from`. */
function aiReply(from: number, messageId = 'm-ai', conversationId = 'c-1'): StreamEvent[] {
  return [
    { id: from, type: 'message_start', conversationId, messageId, role: 'ai' },
    { id: from + 1, type: 'token', conversationId, messageId, text: 'Your' },
    { id: from + 2, type: 'token', conversationId, messageId, text: ' order' },
    { id: from + 3, type: 'token', conversationId, messageId, text: ' shipped.' },
    { id: from + 4, type: 'message_end', conversationId, messageId },
  ];
}

/** State with the list at event 10 and thread c-1 loaded at event 10. */
function readyState(): LiveState {
  let s = hydrateList(initialLiveState, list(10));
  s = beginThreadLoad(s, 'c-1');
  s = hydrateThread(s, 'c-1', { lastEventId: 10, messages: [msg('m-1', 'customer', 'hello')] }).state;
  return s;
}

const item = (s: LiveState, id: string, conv = 'c-1') => s.threads[conv]?.items[id] as MessageItem | undefined;

// ---- ordering ------------------------------------------------------------------------------

describe('token streaming and ordering', () => {
  it('appends tokens in order into the right message and conversation', () => {
    const { state } = feed(readyState(), aiReply(11));
    expect(item(state, 'm-ai')).toMatchObject({ text: 'Your order shipped.', streaming: false, role: 'ai' });
    expect(state.threads['c-1']?.ids).toEqual(['m-1', 'm-ai']);
    expect(state.conversations['c-1']?.lastMessage).toBe('Your order shipped.');
    expect(state.conversations['c-2']?.lastMessage).toBe('مرحبا');
    expect(state.cursor).toBe(15);
  });

  it('shows the partial reply while streaming, in the thread and in the list preview', () => {
    const { state } = feed(readyState(), aiReply(11).slice(0, 3));
    expect(item(state, 'm-ai')).toMatchObject({ text: 'Your order', streaming: true });
    expect(state.conversations['c-1']?.draft).toEqual({ messageId: 'm-ai', text: 'Your order', partial: false });
    expect(state.conversations['c-1']?.lastMessage).toBe('hello'); // not final yet
  });

  it('a token changes only its own message object (so only that row re-renders)', () => {
    const before = feed(readyState(), aiReply(11).slice(0, 2)).state;
    const after = feed(before, [aiReply(11)[2]!]).state;
    const tb = before.threads['c-1']!;
    const ta = after.threads['c-1']!;
    expect(ta.ids).toBe(tb.ids); // list of rows untouched → the virtualised list does not re-render
    expect(ta.items['m-1']).toBe(tb.items['m-1']); // other rows keep their identity
    expect(ta.items['m-ai']).not.toBe(tb.items['m-ai']);
    expect(after.conversations['c-2']).toBe(before.conversations['c-2']);
  });

  it('keeps two interleaved streams in different conversations apart', () => {
    let s = readyState();
    s = beginThreadLoad(s, 'c-2');
    s = hydrateThread(s, 'c-2', { lastEventId: 10, messages: [] }).state;
    const a = aiReply(11, 'm-a', 'c-1');
    const b = aiReply(16, 'm-b', 'c-2').map((e) => e);
    // interleave: a0 b0 a1 b1 ... with ids re-numbered so the stream stays contiguous
    const mixed: StreamEvent[] = [];
    for (let i = 0; i < 5; i++) mixed.push(a[i]!, b[i]!);
    const renumbered = mixed.map((e, i) => ({ ...e, id: 11 + i }));
    const { state, results } = feed(s, renumbered);
    expect(results.every((r) => r === 'applied')).toBe(true);
    expect(item(state, 'm-a')?.text).toBe('Your order shipped.');
    expect(item(state, 'm-b', 'c-2')?.text).toBe('Your order shipped.');
  });

  it('does not apply an event after a gap and keeps the cursor for the resume', () => {
    const events = aiReply(11);
    const { state, results } = feed(readyState(), [events[0]!, events[2]!]); // id 13 skips 12
    expect(results).toEqual(['applied', 'gap']);
    expect(state.cursor).toBe(11);
    expect(item(state, 'm-ai')?.text).toBe('');
  });

  it('ignores events until the list is hydrated', () => {
    expect(applyEvent(initialLiveState, aiReply(1)[0]!).result).toBe('not_ready');
  });
});

// ---- resume / duplicates -------------------------------------------------------------------

describe('resume after a dropped connection', () => {
  it('ignores the events the server replays a few ids early', () => {
    const events = aiReply(11);
    // First connection delivers 11..13, then drops.
    const first = feed(readyState(), events.slice(0, 3));
    expect(first.state.cursor).toBe(13);
    // Reconnect with since=13: the mock replays from id 11 (3 early), then continues live.
    const replay = feed(first.state, events);
    expect(replay.results).toEqual(['duplicate', 'duplicate', 'duplicate', 'applied', 'applied']);
    expect(item(replay.state, 'm-ai')?.text).toBe('Your order shipped.');
    expect(replay.state.threads['c-1']?.ids).toEqual(['m-1', 'm-ai']);
  });

  it('does not duplicate messages or unread counts on replay', () => {
    const customer: StreamEvent = { id: 11, type: 'message', conversationId: 'c-2', message: { ...msg('m-9', 'customer', 'hi'), conversationId: 'c-2' } };
    const { state } = feed(readyState(), [customer, customer, customer]);
    expect(unreadOf(state.conversations['c-2']!)).toBe(1);
  });

  it('is idempotent when the whole stream is replayed several times', () => {
    const events = aiReply(11);
    let s = readyState();
    for (let round = 0; round < 3; round++) s = feed(s, events).state;
    expect(item(s, 'm-ai')?.text).toBe('Your order shipped.');
    expect(s.threads['c-1']?.ids).toHaveLength(2);
  });
});

// ---- snapshots at a watermark --------------------------------------------------------------

describe('thread snapshots merged with the live stream', () => {
  it('skips events already contained in a newer snapshot', () => {
    // List at 10, stream delivers 11..13 while the thread is not open yet.
    let s = hydrateList(initialLiveState, list(10));
    s = feed(s, aiReply(11).slice(0, 3)).state;
    // Thread opened now; the server already has "Your order" (events up to 13) in the snapshot.
    s = beginThreadLoad(s, 'c-1');
    s = hydrateThread(s, 'c-1', {
      lastEventId: 13,
      messages: [msg('m-1', 'customer', 'hello'), msg('m-ai', 'ai', 'Your order', { streaming: true })],
    }).state;
    s = feed(s, aiReply(11).slice(3)).state;
    expect(item(s, 'm-ai')).toMatchObject({ text: 'Your order shipped.', streaming: false });
    // The list joined mid-reply (no message_start); the snapshot repaired the preview.
    expect(s.conversations['c-1']?.lastMessage).toBe('Your order shipped.');
  });

  it('buffers events that arrive while the snapshot request is in flight', () => {
    let s = hydrateList(initialLiveState, list(10));
    s = beginThreadLoad(s, 'c-1'); // request sent at cursor 10
    const events = aiReply(11);
    s = feed(s, events.slice(0, 4)).state; // 11..14 arrive before the response
    // The server answered after event 12, so the snapshot holds "Your" only.
    s = hydrateThread(s, 'c-1', {
      lastEventId: 12,
      messages: [msg('m-1', 'customer', 'hello'), msg('m-ai', 'ai', 'Your', { streaming: true })],
    }).state;
    expect(item(s, 'm-ai')?.text).toBe('Your order shipped.'); // 13, 14 replayed from the buffer
    s = feed(s, events.slice(4)).state;
    expect(item(s, 'm-ai')?.streaming).toBe(false);
  });

  it('a failed first load forgets the thread so nothing keeps buffering', () => {
    let s = hydrateList(initialLiveState, list(10));
    s = beginThreadLoad(s, 'c-1');
    s = abortThreadLoad(s, 'c-1');
    expect(s.threads['c-1']).toBeUndefined();
    s = feed(s, aiReply(11)).state;
    expect(s.threads['c-1']).toBeUndefined();
  });

  it('a failed re-fetch keeps the old thread and applies what was buffered meanwhile', () => {
    let s = beginThreadLoad(readyState(), 'c-1');
    s = feed(s, aiReply(11)).state;
    s = abortThreadLoad(s, 'c-1');
    expect(s.threads['c-1']?.phase).toBe('ready');
    expect(item(s, 'm-ai')).toMatchObject({ text: 'Your order shipped.', streaming: false });
  });

  it('rejects a snapshot older than the point the request was sent', () => {
    let s = hydrateList(initialLiveState, list(10));
    s = feed(s, aiReply(11).slice(0, 2)).state;
    s = beginThreadLoad(s, 'c-1'); // requested at cursor 12
    expect(hydrateThread(s, 'c-1', { lastEventId: 5, messages: [] }).result).toBe('stale');
  });
});

// ---- hand-off ------------------------------------------------------------------------------

describe('hand-off to a human', () => {
  const handoff: StreamEvent[] = [
    { id: 11, type: 'tool_call', conversationId: 'c-1', name: 'transfer_to_human', args: { reason: 'Refund is above the AI limit (500 SAR)' } },
    { id: 12, type: 'status', conversationId: 'c-1', status: 'needs_human' },
  ];

  it('marks the conversation Needs human as soon as the tool call arrives and shows the reason', () => {
    const { state } = feed(readyState(), handoff.slice(0, 1));
    expect(state.conversations['c-1']).toMatchObject({ status: 'needs_human', handoffReason: 'Refund is above the AI limit (500 SAR)' });
    const note = state.threads['c-1']?.items['handoff-11'];
    expect(note).toEqual({ kind: 'handoff', id: 'handoff-11', reason: 'Refund is above the AI limit (500 SAR)', eventId: 11 });
    expect(state.threads['c-1']?.ids.at(-1)).toBe('handoff-11');
  });

  it('records the hand-off for a conversation whose thread is not open', () => {
    const ev = { ...handoff[0]!, conversationId: 'c-2' } as StreamEvent;
    const { state } = feed(readyState(), [ev]);
    expect(state.conversations['c-2']?.status).toBe('needs_human');
    expect(state.conversations['c-2']?.handoffReason).toMatch(/Refund/);
  });

  it('does not add the hand-off note twice when replayed', () => {
    let s = feed(readyState(), handoff).state;
    s = feed(s, handoff).state;
    expect(s.threads['c-1']?.ids.filter((id) => id.startsWith('handoff'))).toEqual(['handoff-11']);
  });

  it('shows the note in a thread opened after the hand-off (REST data has no trace of it)', () => {
    let s = hydrateList(initialLiveState, list(10));
    s = feed(s, handoff).state; // thread not open yet
    s = beginThreadLoad(s, 'c-1');
    s = hydrateThread(s, 'c-1', { lastEventId: 12, messages: [msg('m-1', 'customer', 'hello')] }).state;
    expect(s.threads['c-1']?.ids).toEqual(['m-1', 'handoff-11']);
    expect(s.threads['c-1']?.items['handoff-11']).toMatchObject({ reason: 'Refund is above the AI limit (500 SAR)' });
  });

  it('keeps a tool_call that falls inside the snapshot window while loading', () => {
    let s = hydrateList(initialLiveState, list(10));
    s = beginThreadLoad(s, 'c-1');
    s = feed(s, handoff).state; // buffered while the request is in flight
    s = hydrateThread(s, 'c-1', { lastEventId: 12, messages: [msg('m-1', 'customer', 'hello')] }).state;
    expect(s.threads['c-1']?.ids).toEqual(['m-1', 'handoff-11']);
  });

  it('keeps a tool_call that arrives after a snapshot newer than the stream', () => {
    let s = hydrateList(initialLiveState, list(10));
    s = beginThreadLoad(s, 'c-1');
    // The snapshot is ahead of the stream (it already covers 11 and 12).
    s = hydrateThread(s, 'c-1', { lastEventId: 12, messages: [msg('m-1', 'customer', 'hello')] }).state;
    s = feed(s, handoff).state;
    expect(s.threads['c-1']?.ids).toEqual(['m-1', 'handoff-11']);
    expect(s.conversations['c-1']?.status).toBe('needs_human');
  });

  it('keeps the reason through takeover and clears it when the AI gets the chat back', () => {
    let s = feed(readyState(), handoff).state;
    s = feed(s, [{ id: 13, type: 'status', conversationId: 'c-1', status: 'human' }]).state;
    expect(s.conversations['c-1']?.handoffReason).toMatch(/Refund/);
    s = feed(s, [{ id: 14, type: 'status', conversationId: 'c-1', status: 'ai' }]).state;
    expect(s.conversations['c-1']?.handoffReason).toBeNull();
  });
});

// ---- optimistic sends ----------------------------------------------------------------------

describe('optimistic human replies', () => {
  const human = (id: number): StreamEvent => ({
    id,
    type: 'message',
    conversationId: 'c-1',
    message: msg('m-50', 'human', 'On it', { clientMessageId: 'cm-1' }),
  });

  it('replaces the pending bubble when the stream echoes the clientMessageId', () => {
    let s = addPending(readyState(), { conversationId: 'c-1', clientMessageId: 'cm-1', text: 'On it' });
    expect(s.pending['c-1']).toHaveLength(1);
    s = feed(s, [human(11)]).state;
    expect(s.pending['c-1']).toHaveLength(0);
    expect(s.threads['c-1']?.ids).toEqual(['m-1', 'm-50']);
  });

  it('handles the HTTP response arriving before or after the stream event', () => {
    // response first: stays pending (marked sent) until the stream places it
    let s = addPending(readyState(), { conversationId: 'c-1', clientMessageId: 'cm-1', text: 'On it' });
    s = confirmPending(s, 'c-1', 'cm-1', 'm-50');
    expect(s.pending['c-1']?.[0]).toMatchObject({ state: 'sent', messageId: 'm-50' });
    s = feed(s, [human(11)]).state;
    expect(s.pending['c-1']).toHaveLength(0);
    // stream first: the late response is a no-op
    s = confirmPending(s, 'c-1', 'cm-1', 'm-50');
    expect(s.threads['c-1']?.ids.filter((id) => id === 'm-50')).toHaveLength(1);
  });

  it('knows when a send that errored on our side was delivered anyway', () => {
    let s = addPending(readyState(), { conversationId: 'c-1', clientMessageId: 'cm-1', text: 'On it' });
    expect(hasDelivered(s, 'c-1', 'cm-1')).toBe(false);
    s = feed(s, [human(11)]).state;
    expect(hasDelivered(s, 'c-1', 'cm-1')).toBe(true);
  });
});

// ---- list behaviour ------------------------------------------------------------------------

describe('conversation list', () => {
  it('counts unread customer messages only for conversations not being viewed', () => {
    let s = selectConversation(readyState(), 'c-1');
    expect(unreadOf(s.conversations['c-1']!)).toBe(0);
    s = feed(s, [
      { id: 11, type: 'message', conversationId: 'c-1', message: msg('m-2', 'customer', 'still there?') },
      { id: 12, type: 'message', conversationId: 'c-2', message: { ...msg('m-3', 'customer', 'مرحبا'), conversationId: 'c-2' } },
    ]).state;
    expect(unreadOf(s.conversations['c-1']!)).toBe(0);
    expect(unreadOf(s.conversations['c-2']!)).toBe(1);
  });

  it('moves the most recently active conversation to the top', () => {
    let s = readyState();
    expect(sortedConversationIds(s.conversations)).toEqual(['c-1', 'c-2']);
    s = feed(s, [{ id: 11, type: 'message', conversationId: 'c-2', message: { ...msg('m-3', 'customer', 'hi'), conversationId: 'c-2' } }]).state;
    expect(sortedConversationIds(s.conversations)).toEqual(['c-2', 'c-1']);
  });
});
