import { useEffect } from 'react';
import { useLiveSync } from '../live/useLiveSync';
import { useStore } from '../live/store';
import { Header } from './Header';
import { ConversationList } from './ConversationList';
import { Thread } from './Thread';

export function App() {
  const list = useLiveSync();
  const dir = useStore((s) => s.dir);
  const selectedId = useStore((s) => s.selectedId);

  useEffect(() => {
    document.documentElement.dir = dir;
    document.documentElement.lang = dir === 'rtl' ? 'ar' : 'en';
  }, [dir]);

  return (
    <div className="app">
      <Header />
      <main className="layout">
        <aside className="sidebar" aria-label="Conversations">
          {list.isPending ? (
            <p className="muted pad">Loading conversations…</p>
          ) : list.isError ? (
            <div className="pad">
              <p className="error">Could not load conversations: {list.error.message}</p>
              <button type="button" onClick={() => void list.refetch()}>Retry</button>
            </div>
          ) : (
            <ConversationList />
          )}
        </aside>
        <section className="thread-pane">
          {selectedId ? <Thread key={selectedId} conversationId={selectedId} /> : <p className="muted empty">Select a conversation</p>}
        </section>
      </main>
    </div>
  );
}
