/**
 * SSE connection manager with explicit resume.
 *
 * We do not rely on EventSource's built-in retry: it reconnects to the *original* URL, and the
 * mock gives `?since=` precedence over the Last-Event-ID header, so every retry would replay from
 * the very first position. Instead, on any error we close the EventSource ourselves and open a new
 * one with `since=<last event we processed>`. The replay starts a few events early on purpose;
 * the reducer drops anything at or below the cursor.
 */
import type { StreamEvent } from '../types';
import type { ApplyResult } from './reducer';
import type { ConnectionState } from './store';

export interface EventSourceLike {
  onopen: ((this: EventSourceLike, ev: Event) => unknown) | null;
  onmessage: ((this: EventSourceLike, ev: MessageEvent<string>) => unknown) | null;
  onerror: ((this: EventSourceLike, ev: Event) => unknown) | null;
  close(): void;
}

export interface EventStreamOptions {
  url(since: number): string;
  getCursor(): number | null;
  onEvent(ev: StreamEvent): ApplyResult;
  onState(state: ConnectionState): void;
  /**
   * The stream cannot be resumed (event ids went backwards after a server restart, or a gap
   * persists across reconnects). The stream is stopped; the caller must reload all data.
   */
  onResyncNeeded(reason: string): void;
  createEventSource?: (url: string) => EventSourceLike;
  /** Delay before reconnect attempt `n` (0-based). */
  backoff?: (attempt: number) => number;
  /** Reconnect when nothing (not even a ping) arrives for this long. The mock pings every 15 s. */
  idleTimeoutMs?: number;
}

const defaultBackoff = (attempt: number) => Math.min(250 * 2 ** attempt, 5000) + Math.floor(Math.random() * 200);

export class EventStream {
  private es: EventSourceLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  /** Gaps seen in a row without a single event applied in between. */
  private gapStreak = 0;
  private running = false;
  private readonly opts: Required<EventStreamOptions>;

  constructor(opts: EventStreamOptions) {
    this.opts = {
      createEventSource: (url) => new EventSource(url) as unknown as EventSourceLike,
      backoff: defaultBackoff,
      idleTimeoutMs: 40_000,
      ...opts,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.connect('connecting');
  }

  stop() {
    this.running = false;
    this.teardown();
    this.opts.onState('idle');
  }

  private connect(state: ConnectionState) {
    const since = this.opts.getCursor();
    if (since === null) throw new Error('EventStream started before the cursor was known');
    this.opts.onState(state);

    const es = this.opts.createEventSource(this.opts.url(since));
    this.es = es;
    // The replay begins at since-2 at the earliest. Anything lower on a fresh connection means
    // the server's event ids were reset.
    let first = true;

    es.onopen = () => {
      if (this.es !== es) return;
      this.attempt = 0;
      this.opts.onState('connected');
      this.armIdleTimer();
    };
    es.onmessage = (msg) => {
      if (this.es !== es) return; // late message from a connection we already dropped
      this.armIdleTimer();
      let ev: StreamEvent;
      try {
        ev = JSON.parse(msg.data) as StreamEvent;
      } catch {
        return;
      }
      if (first) {
        first = false;
        if (since > 0 && ev.id < since - 2) return this.resync('server event ids were reset');
      }
      const result = this.opts.onEvent(ev);
      if (result === 'applied') this.gapStreak = 0;
      else if (result === 'gap') {
        // One gap: reconnect at once and let the replay fill it. If the replay cannot fill it,
        // reconnecting again would loop forever, so fall back to a full reload instead.
        if (++this.gapStreak >= 3) return this.resync('gap could not be filled by a replay');
        this.scheduleReconnect(true);
      }
    };
    es.onerror = () => {
      if (this.es !== es) return;
      this.scheduleReconnect(false);
    };
  }

  private resync(reason: string) {
    this.gapStreak = 0;
    this.stop();
    this.opts.onResyncNeeded(reason);
  }

  private scheduleReconnect(immediate: boolean) {
    this.teardown();
    if (!this.running) return;
    this.opts.onState('reconnecting');
    const delay = immediate ? 0 : this.opts.backoff(this.attempt++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running) this.connect('reconnecting');
    }, delay);
  }

  private armIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.scheduleReconnect(false), this.opts.idleTimeoutMs);
  }

  private teardown() {
    if (this.es) {
      // Close explicitly so the browser's own retry (which would resume from the stale URL) never runs.
      this.es.onopen = this.es.onmessage = this.es.onerror = null;
      this.es.close();
      this.es = null;
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.retryTimer = this.idleTimer = null;
  }
}
