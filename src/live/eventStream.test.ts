import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../types';
import { EventStream, type EventSourceLike } from './eventStream';
import { applyEvent, hydrateList, initialLiveState, type LiveState } from './reducer';

class FakeEventSource implements EventSourceLike {
  onopen: EventSourceLike['onopen'] = null;
  onmessage: EventSourceLike['onmessage'] = null;
  onerror: EventSourceLike['onerror'] = null;
  closed = false;
  constructor(readonly url: string) {}
  open() {
    this.onopen?.call(this, new Event('open'));
  }
  send(ev: StreamEvent) {
    this.onmessage?.call(this, new MessageEvent('message', { data: JSON.stringify(ev) }));
  }
  drop() {
    this.onerror?.call(this, new Event('error'));
  }
  close() {
    this.closed = true;
  }
}

const tok = (id: number, text: string): StreamEvent => ({ id, type: 'token', conversationId: 'c-1', messageId: 'm-1', text });
const start = (id: number): StreamEvent => ({ id, type: 'message_start', conversationId: 'c-1', messageId: 'm-1', role: 'ai' });

function setup() {
  let state: LiveState = hydrateList(initialLiveState, {
    lastEventId: 10,
    conversations: [{ id: 'c-1', customer: 'Sara', status: 'ai', lastMessage: '', unread: 0, updatedAt: '' }],
  });
  const sources: FakeEventSource[] = [];
  const states: string[] = [];
  const onResyncNeeded = vi.fn();
  const stream = new EventStream({
    url: (since) => `/events?since=${since}`,
    getCursor: () => state.cursor,
    onEvent: (ev) => {
      const r = applyEvent(state, ev);
      state = r.state;
      return r.result;
    },
    onState: (s) => states.push(s),
    onResyncNeeded,
    createEventSource: (url) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    },
    backoff: () => 100,
  });
  return { stream, sources, states, onResyncNeeded, get state() { return state; } };
}

describe('EventStream reconnect', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens from the snapshot cursor and resumes from the last processed event after a drop', () => {
    const t = setup();
    t.stream.start();
    expect(t.sources[0]!.url).toBe('/events?since=10');
    t.sources[0]!.open();
    t.sources[0]!.send(start(11));
    t.sources[0]!.send(tok(12, 'Hello'));
    t.sources[0]!.drop();

    expect(t.sources[0]!.closed).toBe(true); // we close it so the browser does not retry the old URL
    expect(t.states.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(100);
    expect(t.sources[1]!.url).toBe('/events?since=12');

    // The server replays from 3 before `since`; nothing may be applied twice.
    t.sources[1]!.open();
    for (const ev of [start(11), tok(12, 'Hello'), tok(13, ' world')]) t.sources[1]!.send(ev);
    expect(t.states.at(-1)).toBe('connected');
    expect(t.state.cursor).toBe(13);
    const item = t.state.threads['c-1'];
    expect(item).toBeUndefined(); // thread not open: only the list preview is tracked
    expect(t.state.conversations['c-1']?.draft?.text).toBe('Hello world');
  });

  it('ignores messages from a connection it already dropped', () => {
    const t = setup();
    t.stream.start();
    const old = t.sources[0]!;
    old.open();
    old.drop();
    old.send(start(11)); // a late frame on the dead connection
    expect(t.state.cursor).toBe(10);
  });

  it('reconnects immediately from the cursor when it sees a gap', () => {
    const t = setup();
    t.stream.start();
    t.sources[0]!.open();
    t.sources[0]!.send(start(11));
    t.sources[0]!.send(tok(14, 'x')); // 12 and 13 missing
    vi.advanceTimersByTime(0);
    expect(t.sources[1]!.url).toBe('/events?since=11');
    expect(t.state.cursor).toBe(11);
  });

  it('detects a server restart (event ids went backwards) and asks for a full reload', () => {
    const t = setup();
    t.stream.start();
    t.sources[0]!.open();
    t.sources[0]!.send(tok(1, 'x'));
    expect(t.onResyncNeeded).toHaveBeenCalledOnce();
    expect(t.sources[0]!.closed).toBe(true);
  });

  it('falls back to a full reload when a gap survives several replays (no reconnect loop)', () => {
    const t = setup();
    t.stream.start();
    t.sources[0]!.open();
    t.sources[0]!.send(start(11));
    for (let i = 0; i < 3; i++) {
      const es = t.sources.at(-1)!;
      es.open();
      es.send(tok(15, 'x')); // 12 never arrives
      vi.advanceTimersByTime(0);
    }
    expect(t.onResyncNeeded).toHaveBeenCalledOnce();
    expect(t.sources).toHaveLength(3);
    vi.advanceTimersByTime(10_000);
    expect(t.sources).toHaveLength(3); // stopped, no further reconnects
  });

  it('stops cleanly', () => {
    const t = setup();
    t.stream.start();
    t.stream.stop();
    expect(t.sources[0]!.closed).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(t.sources).toHaveLength(1);
  });
});
