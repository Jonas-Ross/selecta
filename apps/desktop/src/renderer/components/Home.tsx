import { useEffect, useState } from 'react';
import type { DraftSummary } from '../../shared/protocol.js';
import { selecta } from '../api.js';
import { orphanRuns, saveLabel, type Run } from '../state.js';
import { TopBar } from './TopBar.js';

export function Home({
  runs,
  onNew,
  onOpen,
}: {
  runs: Record<string, Run>;
  onNew: () => void;
  onOpen: (draftId: string) => void;
}) {
  const [drafts, setDrafts] = useState<DraftSummary[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const load = () =>
      selecta.call('drafts.list').then(setDrafts, (e: Error) => setError(e.message));

    void load();

    return selecta.on((event) => {
      if (event.event === 'drafts.changed') void load();
    });
  }, []);

  const orphans = drafts ? orphanRuns(runs, drafts) : [];

  return (
    <>
      <TopBar
        right={
          <button type="button" className="btn primary" onClick={onNew}>
            New playlist
          </button>
        }
      />
      <main className="page">
        <div className="column">
          <div className="page-head">
            <h1>Drafts</h1>
            {drafts && (
              <span className="mono count">{drafts.length + orphans.length} on this Mac</span>
            )}
          </div>
          {error && <p className="notice error">{error}</p>}
          {drafts?.length === 0 && !orphans.length && (
            <div className="empty">
              <b>No drafts yet</b>
              <p>Describe a playlist and your AI builds it from your library.</p>
              <button type="button" className="btn uv" onClick={onNew}>
                New playlist
              </button>
            </div>
          )}
          <ul className="drafts">
            {orphans.map((run) => (
              <li key={run.draft_id}>
                <button type="button" onClick={() => onOpen(run.draft_id)}>
                  <span className="draft-name">{run.brief.split('\n')[0] || 'New playlist'}</span>
                  <span className={run.working ? 'draft-meta working' : 'draft-meta error'}>
                    {run.working ? 'Building…' : 'Build failed'}
                  </span>
                </button>
              </li>
            ))}
            {drafts?.map((draft) => (
              <li key={draft.draft_id}>
                <button type="button" onClick={() => onOpen(draft.draft_id)}>
                  <span className="draft-name">{draft.name}</span>
                  <span className="draft-meta">
                    {draft.track_count} tracks
                    {draft.save && (
                      <span className="saved"> · {saveLabel(draft.save).toLowerCase()}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </main>
    </>
  );
}
