import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useStore, type SendError } from '../live/store';
import { newClientId, useSendMessage } from '../live/mutations';

const NO_ERRORS: SendError[] = [];

export function Composer({ conversationId, enabled }: { conversationId: string; enabled: boolean }) {
  const [text, setText] = useState('');
  const send = useSendMessage(conversationId);
  const sendErrors = useStore((s) => s.sendErrors[conversationId] ?? NO_ERRORS);
  const clearSendError = useStore((s) => s.clearSendError);

  const submit = (value: string, clientMessageId = newClientId()) => {
    const trimmed = value.trim();
    if (!trimmed || !enabled) return;
    send.mutate({ text: trimmed, clientMessageId });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(text);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit(text);
      setText('');
    }
  };

  return (
    <div className="composer-wrap">
      {sendErrors.map((err) => (
        <div key={err.clientMessageId} className="error-banner" role="alert">
          <span>
            Not sent: “<bdi>{err.text}</bdi>” ({err.error})
          </span>
          <span className="actions">
            {/* Same clientMessageId: the failed request created nothing on the server. */}
            <button type="button" onClick={() => submit(err.text, err.clientMessageId)} disabled={!enabled}>
              Retry
            </button>
            <button
              type="button"
              onClick={() => {
                if (!text) setText(err.text);
                clearSendError(conversationId, err.clientMessageId);
              }}
            >
              Edit
            </button>
            <button type="button" onClick={() => clearSendError(conversationId, err.clientMessageId)}>
              Dismiss
            </button>
          </span>
        </div>
      ))}
      <form className="composer" onSubmit={onSubmit}>
        <textarea
          dir="auto"
          rows={2}
          value={text}
          disabled={!enabled}
          placeholder={enabled ? 'Write a reply… (Enter to send, Shift+Enter for a new line)' : 'Take over the conversation to reply'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Reply"
        />
        <button type="submit" className="primary" disabled={!enabled || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
