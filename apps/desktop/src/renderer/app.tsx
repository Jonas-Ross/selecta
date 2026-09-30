import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentEvent, DraftSummary, SelectaApi } from '../shared/protocol.js';
import {
  askRun,
  feedbackMessage,
  formatDuration,
  move,
  orphanRuns,
  previewLinked,
  rows,
  runEvent,
  saveLabel,
  saveOutcome,
  totalDuration,
  type DraftView,
  type Row,
  type Run,
} from './state.js';

declare global {
  interface Window {
    selecta: SelectaApi;
  }
}

const { selecta } = window;

type Screen = { name: 'home' } | { name: 'brief' } | { name: 'draft'; draftId: string };

function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [runs, setRuns] = useState<Record<string, Run>>({});

  const onAgent = useCallback(
    (draftId: string, event: AgentEvent) =>
      setRuns((current) => ({ ...current, [draftId]: runEvent(current[draftId], event) })),
    [],
  );

  useEffect(() => {
    const unsubscribe = selecta.on((event) => {
      if (event.event === 'agent') onAgent(event.draft_id, event.data);
    });

    // After a renderer reload the host may still be running Claude; a run that
    // already reported back keeps its own state.
    selecta.call('agent.active').then((ids) =>
      setRuns((current) => ({
        ...Object.fromEntries(ids.map((id) => [id, { log: [], working: true }])),
        ...current,
      })),
    );

    return unsubscribe;
  }, [onAgent]);

  // A call the host rejects never starts Claude, so no event would clear `working`.
  const ask = useCallback(
    (draftId: string, text: string, call: Promise<unknown>) => {
      setRuns((current) => ({ ...current, [draftId]: askRun(current[draftId], text) }));
      call.catch((e: Error) => onAgent(draftId, { kind: 'error', message: e.message }));
    },
    [onAgent],
  );

  const start = (draftId: string, brief: string) =>
    ask(draftId, brief, selecta.call('agent.start', { draft_id: draftId, brief }));

  if (screen.name === 'brief')
    return (
      <Brief
        onCancel={() => setScreen({ name: 'home' })}
        onStart={(brief) => {
          const draftId = crypto.randomUUID();

          start(draftId, brief);
          setScreen({ name: 'draft', draftId });
        }}
      />
    );

  if (screen.name === 'draft') {
    const { draftId } = screen;

    return (
      <Draft
        key={draftId}
        draftId={draftId}
        run={runs[draftId]}
        onStart={(brief) => start(draftId, brief)}
        onSend={(text, message) =>
          ask(draftId, text, selecta.call('agent.send', { draft_id: draftId, message }))
        }
        onBack={() => setScreen({ name: 'home' })}
      />
    );
  }

  return (
    <Home
      runs={runs}
      onNew={() => setScreen({ name: 'brief' })}
      onOpen={(draftId) => setScreen({ name: 'draft', draftId })}
    />
  );
}

function Home({
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

    load();

    return selecta.on((event) => event.event === 'drafts.changed' && load());
  }, []);

  const orphans = drafts ? orphanRuns(runs, drafts) : [];

  return (
    <main>
      <header>
        <h1>Selecta</h1>
        <button className="primary" onClick={onNew}>
          New playlist
        </button>
      </header>
      {error && <p className="error">{error}</p>}
      {drafts?.length === 0 && !orphans.length && <p className="muted">No drafts yet.</p>}
      <ul className="drafts">
        {orphans.map((run) => (
          <li key={run.draft_id}>
            <button onClick={() => onOpen(run.draft_id)}>
              <strong>{run.brief.split('\n')[0] || 'New playlist'}</strong>
              <span className="muted">{run.working ? 'Building…' : 'Build failed'}</span>
            </button>
          </li>
        ))}
        {drafts?.map((draft) => (
          <li key={draft.draft_id}>
            <button onClick={() => onOpen(draft.draft_id)}>
              <strong>{draft.name}</strong>
              <span className="muted">
                {draft.track_count} tracks{draft.save_status === 'finished' ? ' · saved' : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

function Brief({ onCancel, onStart }: { onCancel: () => void; onStart: (brief: string) => void }) {
  const [text, setText] = useState('');
  const [length, setLength] = useState('');
  const [tempo, setTempo] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();

    const brief = [
      text.trim(),
      length && `Length: about ${length} tracks.`,
      tempo && `Tempo: ${tempo} BPM.`,
    ]
      .filter(Boolean)
      .join('\n');

    onStart(brief);
  }

  return (
    <main>
      <header>
        <h1>New playlist</h1>
        <button onClick={onCancel}>Cancel</button>
      </header>
      <form className="brief" onSubmit={submit}>
        <label>
          What are you after?
          <textarea
            autoFocus
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Late-night deep house that builds slowly, nothing too vocal"
          />
        </label>
        <div className="row">
          <label>
            Tracks
            <input inputMode="numeric" value={length} onChange={(e) => setLength(e.target.value)} />
          </label>
          <label>
            Tempo
            <input value={tempo} onChange={(e) => setTempo(e.target.value)} placeholder="118-124" />
          </label>
        </div>
        <button className="primary" disabled={!text.trim()}>
          Build it
        </button>
      </form>
    </main>
  );
}

function Draft({
  draftId,
  run,
  onStart,
  onSend,
  onBack,
}: {
  draftId: string;
  run?: Run;
  onStart: (brief: string) => void;
  onSend: (text: string, message: string) => void;
  onBack: () => void;
}) {
  const [view, setView] = useState<DraftView>();
  const log = run?.log ?? [];
  const working = run?.working ?? false;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState('');
  const [dragFrom, setDragFrom] = useState<number>();
  const [notice, setNotice] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const naming = useRef(false);
  const renaming = useRef<Promise<DraftView | undefined>>(undefined);
  const logEnd = useRef<HTMLLIElement>(null);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' });
  }, [run]);

  const load = useCallback(
    () =>
      selecta.call('drafts.get', { draft_id: draftId }).then(
        (value) => setView(value as DraftView),
        (e: Error) => setNotice(e.message),
      ),
    [draftId],
  );

  useEffect(() => {
    load();

    return selecta.on((event) => event.event === 'drafts.changed' && load());
  }, [load]);

  const draft = view?.draft;
  const items = rows(view ?? {});
  const saved = draft?.save !== undefined;
  const linked = previewLinked(view ?? {});
  const locked = saved || linked;

  // Live revisions keep arriving from Claude; don't overwrite a name being typed.
  useEffect(() => {
    if (draft && !naming.current) setName(draft.name);
  }, [draft]);

  // Revision checks mean a stale edit fails rather than clobbering Claude's.
  async function edit(change: Record<string, unknown>): Promise<DraftView | undefined> {
    if (!draft) return;

    try {
      const result = (await selecta.call('drafts.edit', {
        draft_id: draftId,
        revision: draft.revision,
        ...change,
      })) as DraftView;

      if (result.error) {
        setNotice([result.error, result.hint].filter(Boolean).join(' '));
        await load();
      } else {
        setView(result);

        return result;
      }
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  const setEntries = (next: Row[]) =>
    edit({ entries: next.map(({ entry_id, track_id }) => ({ entry_id, track_id })) });

  function send(event: FormEvent) {
    event.preventDefault();

    const text = feedback.trim();

    setFeedback('');

    // A build that failed before creating the draft has nothing to revise.
    if (!draft) return onStart(text);

    onSend(
      text,
      feedbackMessage(
        text,
        items.filter((row) => selected.has(row.entry_id)),
      ),
    );
  }

  async function save() {
    // Clicking Save blurs the name field first; save the renamed revision, not this render's.
    const latest = (await renaming.current)?.draft ?? draft;

    if (!latest || !window.confirm(`Save "${latest.name}" to Music as a new playlist?`)) return;

    setSaving(true);

    try {
      const result = (await selecta.call('drafts.save', {
        draft_id: draftId,
        revision: latest.revision,
      })) as DraftView & { result?: Record<string, unknown> };

      setNotice(saveOutcome(result));
      await load();
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="draft">
      <header>
        <button onClick={onBack}>Back</button>
        {draft ? (
          <input
            className="name"
            value={name}
            disabled={locked}
            onChange={(e) => setName(e.target.value)}
            onFocus={() => (naming.current = true)}
            onBlur={() => {
              naming.current = false;

              if (name.trim() && name.trim() !== draft.name) {
                const pending = edit({ name: name.trim() });

                renaming.current = pending;
                pending.finally(() => {
                  if (renaming.current === pending) renaming.current = undefined;
                });
              } else setName(draft.name);
            }}
          />
        ) : (
          <h1>{working ? 'Building…' : 'No draft yet'}</h1>
        )}
        <button className="primary" disabled={!draft || saved || saving || working} onClick={save}>
          {saving ? 'Saving…' : saveLabel(draft?.save)}
        </button>
      </header>
      {linked && (
        <p className="notice">
          This draft is linked to the Selecta Preview playlist in Music, so it's read-only here.
          Detach the preview where you started it to edit.
        </p>
      )}
      {notice && (
        <p className="notice" onClick={() => setNotice(undefined)}>
          {notice}
        </p>
      )}
      <div className="split">
        <section>
          {draft && <p className="muted">{totalDuration(items)}</p>}
          <ol className="tracks">
            {items.map((row, index) => (
              <li
                key={row.entry_id}
                draggable={!locked}
                className={dragFrom === index ? 'dragging' : undefined}
                onDragStart={() => setDragFrom(index)}
                onDragEnd={() => setDragFrom(undefined)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragFrom !== undefined && dragFrom !== index)
                    setEntries(move(items, dragFrom, index));
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(row.entry_id)}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current);

                      if (!next.delete(row.entry_id)) next.add(row.entry_id);

                      return next;
                    })
                  }
                />
                <span className="title">
                  {row.title ?? row.track_id}
                  <span className="muted"> {row.artist}</span>
                </span>
                <span className="muted">{row.bpm ? Math.round(row.bpm) : ''}</span>
                <span className="muted">{row.camelot ?? ''}</span>
                <span className="muted">{formatDuration(row.duration_seconds)}</span>
                <button
                  className="remove"
                  disabled={locked || items.length === 1}
                  onClick={() =>
                    setEntries(items.filter((other) => other.entry_id !== row.entry_id))
                  }
                  aria-label="Remove"
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
        </section>
        <aside>
          <ol className="log">
            {log.map((item, index) => (
              <li key={index} className={item.kind}>
                {item.text}
              </li>
            ))}
            <li ref={logEnd} className="tool">
              {working ? 'working…' : ''}
            </li>
          </ol>
          <form onSubmit={send}>
            <textarea
              rows={3}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder={
                !draft && !working
                  ? 'Describe the playlist to try again'
                  : selected.size
                    ? `About ${selected.size} selected…`
                    : 'Tell Claude what to change'
              }
            />
            <div className="row">
              {working ? (
                <button
                  type="button"
                  onClick={() => selecta.call('agent.cancel', { draft_id: draftId })}
                >
                  Stop
                </button>
              ) : (
                <button className="primary" disabled={!feedback.trim() || locked}>
                  Send
                </button>
              )}
            </div>
          </form>
        </aside>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
