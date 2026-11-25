import { useCallback, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../live/store';
import { useThread } from '../live/useLiveSync';
import { useTakeover } from '../live/mutations';
import { STATUS_LABEL } from '../labels';
import { MessageRow, PendingRow } from './MessageRow';
import { Composer } from './Composer';

const EMPTY: string[] = [];
const PENDING_PREFIX = 'pending:';

export function Thread({ conversationId }: { conversationId: string }) {
  const query = useThread(conversationId);
  const conv = useStore((s) => s.conversations[conversationId]);
  const ids = useStore((s) => s.threads[conversationId]?.ids ?? EMPTY);
  const phase = useStore((s) => s.threads[conversationId]?.phase);
  const pendingIds = useStore(
    useShallow((s) => (s.pending[conversationId] ?? []).map((p) => PENDING_PREFIX + p.clientMessageId)),
  );
  const takeover = useTakeover(conversationId);

  const data = useMemo(() => (pendingIds.length ? [...ids, ...pendingIds] : ids), [ids, pendingIds]);
  const virtuoso = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  /**
   * "Stick to the bottom" follows the *user's* intent, not Virtuoso's at-bottom flag: a growing
   * streaming reply or a late height measurement can push the view off the bottom for a frame,
   * and that must not unpin it. Only scrolling up by hand does.
   */
  const stick = useRef(true);
  const scroller = useRef<HTMLElement | null>(null);
  /** Unpin only if the list can actually scroll up from here. */
  const unstick = () => {
    if ((scroller.current?.scrollTop ?? 0) > 0) stick.current = false;
  };
  /** Pointer down on the scrollbar itself (left side in RTL), not on a message or blank space. */
  const onScrollbar = (e: React.PointerEvent) => {
    const el = scroller.current;
    if (!el || e.target !== el) return false;
    const gutter = el.offsetWidth - el.clientWidth;
    if (gutter <= 0) return false;
    const rect = el.getBoundingClientRect();
    return getComputedStyle(el).direction === 'rtl' ? e.clientX < rect.left + gutter : e.clientX > rect.right - gutter;
  };
  const scrollToEnd = useCallback(() => virtuoso.current?.scrollToIndex({ index: 'LAST', align: 'end' }), []);

  const itemContent = useCallback(
    (_index: number, id: string) =>
      id.startsWith(PENDING_PREFIX) ? (
        <PendingRow conversationId={conversationId} clientMessageId={id.slice(PENDING_PREFIX.length)} />
      ) : (
        <MessageRow conversationId={conversationId} id={id} />
      ),
    [conversationId],
  );

  if (!conv) return null;
  const ready = phase === 'ready' || ids.length > 0;

  return (
    <div className="thread">
      <div className="thread-header">
        <div>
          <h2>
            <bdi>{conv.customer}</bdi>
          </h2>
          <span className={`badge status-${conv.status}`}>{STATUS_LABEL[conv.status]}</span>
        </div>
        <button
          type="button"
          className="primary"
          disabled={conv.status !== 'needs_human' || takeover.isPending}
          onClick={() => takeover.mutate()}
          title={conv.status === 'needs_human' ? 'Take over this conversation' : 'Available when the AI asks for a human'}
        >
          {takeover.isPending ? 'Taking over…' : conv.status === 'human' ? 'You are handling this' : 'Take over'}
        </button>
      </div>

      {conv.status === 'needs_human' && (
        <div className="handoff-banner" role="alert">
          <strong>
            <bdi>The AI asked for a human.</bdi>
          </strong>{' '}
          <span dir="auto">{conv.handoffReason ?? 'No reason received (the hand-off happened before this page loaded).'}</span>
        </div>
      )}
      {takeover.isError && <div className="error-banner">Take over failed: {takeover.error.message}</div>}

      <div
        className="messages"
        onWheel={(e) => e.deltaY < 0 && unstick()}
        onTouchMove={unstick}
        onKeyDown={(e) => ['ArrowUp', 'PageUp', 'Home'].includes(e.key) && unstick()}
        onPointerDown={(e) => onScrollbar(e) && unstick()}
      >
        {!ready ? (
          query.isError ? (
            <div className="pad">
              <p className="error">Could not load messages: {query.error.message}</p>
              <button type="button" onClick={() => void query.refetch()}>Retry</button>
            </div>
          ) : (
            <p className="muted pad">Loading messages…</p>
          )
        ) : (
          <>
            <Virtuoso
              ref={virtuoso}
              scrollerRef={(el) => {
                scroller.current = el instanceof HTMLElement ? el : null;
              }}
              className="virtuoso"
              data={data}
              computeItemKey={(_i, id) => id}
              itemContent={itemContent}
              initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
              followOutput={() => (stick.current ? 'auto' : false)}
              // Fires when a row grows (streaming tokens) or gets measured: re-pin if pinned.
              totalListHeightChanged={() => stick.current && scrollToEnd()}
              atBottomStateChange={(bottom) => {
                setAtBottom(bottom);
                if (bottom) stick.current = true;
              }}
              atBottomThreshold={80}
              increaseViewportBy={{ top: 400, bottom: 200 }}
            />
            {!atBottom && (
              <button
                type="button"
                className="jump"
                onClick={() => {
                  stick.current = true;
                  scrollToEnd();
                }}
              >
                ↓ Latest
              </button>
            )}
          </>
        )}
      </div>

      <Composer conversationId={conversationId} enabled={conv.status === 'human'} />
    </div>
  );
}
