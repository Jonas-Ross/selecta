import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentEvent, DraftSummary, SelectaApi } from '../shared/protocol.js';
import {
  feedbackMessage,
  formatDuration,
  logAgentEvent,
  move,
  previewLinked,
  rows,
  saveLabel,
  saveOutcome,
  totalDuration,
  type DraftView,
  type LogItem,
  type Row,
} from './state.js';

declare global {
  interface Window {
    selecta: SelectaApi;
  }
}

const { selecta } = window;

type Screen =
  | { name: 'home' }
  | { name: 'brief' }
  | { name: 'draft'; draftId: string; brief?: string };

function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' });

  if (screen.name === 'brief')
    return (
      <Brief
        onCancel={() => setScreen({ name: 'home' })}
        onStart={(brief) => setScreen({ name: 'draft', draftId: crypto.randomUUID(), brief })}
      />
    );

  if (screen.name === 'draft')
    return (
      <Draft
        key={screen.draftId}
        draftId={screen.draftId}
        brief={screen.brief}
        onBack={() => setScreen({ name: 'home' })}
      />
    );

  return (
    <Home
      onNew={() => setScreen({ name: 'brief' })}
      onOpen={(draftId) => setScreen({ name: 'draft', draftId })}
    />
  );
}

function Home({ onNew, onOpen }: { onNew: () => void; onOpen: (draftId: string) => void }) {
  const [drafts, setDrafts] = useState<DraftSummary[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const load = () =>
      selecta.call('drafts.list').then(setDrafts, (e: Error) => setError(e.message));

    load();

    return selecta.on((event) => event.event === 'drafts.changed' && load());
  }, []);

  return (
    <main>
      <header>
        <h1>Selecta</h1>
        <button className="primary" onClick={onNew}>
          New playlist
        </button>
      </header>
      {error && <p className="error">{error}</p>}
      {drafts?.length === 0 && <p className="muted">No drafts yet.</p>}
      <ul className="drafts">
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
  brief,
  onBack,
}: {
  draftId: string;
  brief?: string;
  onBack: () => void;
}) {
  const [view, setView] = useState<DraftView>();
  const [log, setLog] = useState<LogItem[]>(brief ? [{ kind: 'you', text: brief }] : []);
  const [working, setWorking] = useState(brief !== undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState('');
  const [dragFrom, setDragFrom] = useState<number>();
  const [notice, setNotice] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const naming = useRef(false);
  const logEnd = useRef<HTMLLIElement>(null);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' });
  }, [log, working]);

  const load = useCallback(
    () =>
      selecta.call('drafts.get', { draft_id: draftId }).then(
        (value) => setView(value as DraftView),
        (e: Error) => setNotice(e.message),
      ),
    [draftId],
  );

  const onAgent = useCallback((event: AgentEvent) => {
    setLog((current) => logAgentEvent(current, event));

    if (event.kind === 'done' || event.kind === 'error') setWorking(false);
  }, []);

  // A call the host rejects never starts Claude, so no event would clear `working`.
  const runAgent = useCallback(
    (call: Promise<unknown>) =>
      call.catch((e: Error) => onAgent({ kind: 'error', message: e.message })),
    [onAgent],
  );

  useEffect(() => {
    load();

    const unsubscribe = selecta.on((event) => {
      if (event.event === 'drafts.changed') load();

      if (event.event === 'agent' && event.draft_id === draftId) onAgent(event.data);
    });

    // Start only once listening, so an immediate failure (no claude CLI) still lands.
    if (brief) runAgent(selecta.call('agent.start', { draft_id: draftId, brief }));
    // Reopened from Home: Claude may still be on it.
    else selecta.call('agent.running', { draft_id: draftId }).then(setWorking);

    return unsubscribe;
  }, [draftId, brief, load, onAgent, runAgent]);

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
  async function edit(change: Record<string, unknown>) {
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
      } else setView(result);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  const setEntries = (next: Row[]) =>
    edit({ entries: next.map(({ entry_id, track_id }) => ({ entry_id, track_id })) });

  async function send(event: FormEvent) {
    event.preventDefault();

    const message = feedbackMessage(
      feedback.trim(),
      items.filter((row) => selected.has(row.entry_id)),
    );

    setLog((current) => [...current, { kind: 'you', text: feedback.trim() }]);
    setFeedback('');
    setWorking(true);
    await runAgent(selecta.call('agent.send', { draft_id: draftId, message }));
  }

  async function save() {
    if (!draft || !window.confirm(`Save "${draft.name}" to Music as a new playlist?`)) return;

    setSaving(true);

    try {
      const result = (await selecta.call('drafts.save', {
        draft_id: draftId,
        revision: draft.revision,
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

              if (name.trim() && name.trim() !== draft.name) edit({ name: name.trim() });
              else setName(draft.name);
            }}
          />
        ) : (
          <h1>Building…</h1>
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
                selected.size ? `About ${selected.size} selected…` : 'Tell Claude what to change'
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
