import { useStore } from '../live/store';

const CONNECTION_LABEL = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
} as const;

export function Header() {
  const connection = useStore((s) => s.connection);
  const reconnects = useStore((s) => s.reconnects);
  const cursor = useStore((s) => s.cursor);
  const dir = useStore((s) => s.dir);
  const setDir = useStore((s) => s.setDir);

  return (
    <header className="header">
      <h1>Supervisor</h1>
      <div className="header-meta">
        <span className={`conn conn-${connection}`} role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          {CONNECTION_LABEL[connection]}
        </span>
        <span className="muted small" title="Last processed event id / reconnects so far">
          event #{cursor ?? '—'} · {reconnects} reconnects
        </span>
        <div className="dir-toggle" role="group" aria-label="Text direction">
          <button type="button" aria-pressed={dir === 'ltr'} onClick={() => setDir('ltr')}>LTR</button>
          <button type="button" aria-pressed={dir === 'rtl'} onClick={() => setDir('rtl')}>RTL</button>
        </div>
      </div>
    </header>
  );
}
