import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../live/store';
import { sortedConversationIds, unreadOf } from '../live/reducer';
import { STATUS_LABEL } from '../labels';

export function ConversationList() {
  const ids = useStore(useShallow((s) => sortedConversationIds(s.conversations)));
  return (
    <ul className="conv-list">
      {ids.map((id) => (
        <ConversationRow key={id} id={id} />
      ))}
    </ul>
  );
}

const ConversationRow = memo(function ConversationRow({ id }: { id: string }) {
  const conv = useStore((s) => s.conversations[id]);
  const selected = useStore((s) => s.selectedId === id);
  const select = useStore((s) => s.select);
  if (!conv) return null;
  const unread = selected ? 0 : unreadOf(conv);
  const preview = conv.draft ? conv.draft.text || '…' : conv.lastMessage;

  return (
    <li>
      <button
        type="button"
        className={`conv-row${selected ? ' selected' : ''}`}
        aria-current={selected ? 'true' : undefined}
        onClick={() => select(id)}
      >
        <span className="conv-top">
          <bdi className="conv-name">{conv.customer}</bdi>
          <span className={`badge status-${conv.status}`}>{STATUS_LABEL[conv.status]}</span>
        </span>
        <span className="conv-bottom">
          <span className={`conv-preview${conv.draft ? ' typing' : ''}`} dir="auto">
            {conv.draft && <span className="typing-label">AI: </span>}
            {preview}
          </span>
          {unread > 0 && (
            <span className="unread" aria-label={`${unread} unread`}>
              {unread}
            </span>
          )}
        </span>
      </button>
    </li>
  );
});
