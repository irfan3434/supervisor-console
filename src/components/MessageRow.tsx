import { memo } from 'react';
import { useStore } from '../live/store';
import { ROLE_LABEL } from '../labels';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** Subscribes to exactly one item, so a token only re-renders the row it belongs to. */
export const MessageRow = memo(function MessageRow({ conversationId, id }: { conversationId: string; id: string }) {
  const item = useStore((s) => s.threads[conversationId]?.items[id]);
  if (!item) return <div className="row" />;

  if (item.kind === 'handoff') {
    return (
      <div className="row row-system">
        <div className="handoff-note">
          <span className="tool">transfer_to_human</span>
          <span dir="auto">{item.reason}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`row row-${item.role}`}>
      <div className={`bubble bubble-${item.role}`}>
        <div className="bubble-meta">
          <span>{ROLE_LABEL[item.role]}</span>
          {item.createdAt && (
            <bdi>
              <time dateTime={item.createdAt}>{timeFormat.format(new Date(item.createdAt))}</time>
            </bdi>
          )}
        </div>
        <p className="bubble-text" dir="auto">
          {item.text}
          {item.streaming && <span className="caret" aria-label="AI is typing" />}
        </p>
      </div>
    </div>
  );
});

export const PendingRow = memo(function PendingRow({
  conversationId,
  clientMessageId,
}: {
  conversationId: string;
  clientMessageId: string;
}) {
  const pending = useStore((s) => s.pending[conversationId]?.find((p) => p.clientMessageId === clientMessageId));
  if (!pending) return <div className="row" />;
  return (
    <div className="row row-human">
      <div className="bubble bubble-human pending">
        <div className="bubble-meta">
          <span>{ROLE_LABEL.human}</span>
          <span>{pending.state === 'sending' ? 'Sending…' : 'Sent'}</span>
        </div>
        <p className="bubble-text" dir="auto">
          {pending.text}
        </p>
      </div>
    </div>
  );
});
