import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { DraftSummary, SelectaApi } from '../shared/protocol.js';
import {
  feedbackMessage,
  formatDuration,
  logAgentEvent,
  move,
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
  | { name: 'draft'; draftId: string; log: LogItem[] };

function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' });

  if (screen.name === 'brief')
    return (
      <Brief
        onCancel={() => setScreen({ name: 'home' })}
        onStart={(draftId, brief) =>
          setScreen({ name: 'draft', draftId, log: [{ kind: 'you', text: brief }] })
        }
      />
    );

  if (screen.name === 'draft')
    return (
      <Draft
        key={screen.draftId}
        draftId={screen.draftId}
        initialLog={screen.log}
        onBack={() => setScreen({ name: 'home' })}
      />
    );

  return (
    <Home
      onNew={() => setScreen({ name: 'brief' })}
      onOpen={(draftId) => setScreen({ name: 'draft', draftId, log: [] })}
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

function Brief({
  onCancel,
  onStart,
}: {
  onCancel: () => void;
  onStart: (draftId: string, brief: string) => void;
}) {
  const [text, setText] = useState('');
  const [length, setLength] = useState('');
  const [tempo, setTempo] = useState('');
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();

    const brief = [
      text.trim(),
      length && `Length: about ${length} tracks.`,
      tempo && `Tempo: ${tempo} BPM.`,
    ]
      .filter(Boolean)
      .join('\n');
    const draftId = crypto.randomUUID();

    try {
      await selecta.call('agent.start', { draft_id: draftId, brief });
      onStart(draftId, brief);
    } catch (e) {
      setError((e as Error).message);
    }
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
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={!text.trim()}>
          Build it
        </button>
      </form>
    </main>
  );
}

function Draft({
  draftId,
  initialLog,
  onBack,
}: {
  draftId: string;
  initialLog: LogItem[];
  onBack: () => void;
}) {
  const [view, setView] = useState<DraftView>();
  const [log, setLog] = useState(initialLog);
  const [working, setWorking] = useState(initialLog.length > 0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState('');
  const [dragFrom, setDragFrom] = useState<number>();
  const [notice, setNotice] = useState<string>();
  const [saving, setSaving] = useState(false);
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

  useEffect(() => {
    load();

    return selecta.on((event) => {
      if (event.event === 'drafts.changed') load();

      if (event.event === 'agent' && event.draft_id === draftId) {
        setLog((current) => logAgentEvent(current, event.data));

        if (event.data.kind === 'done' || event.data.kind === 'error') setWorking(false);
      }
    });
  }, [draftId, load]);

  const draft = view?.draft;
  const items = rows(view ?? {});
  const saved = draft?.save !== undefined;

  // Revision checks mean a stale edit fails rather than clobbering Claude's.
  async function edit(change: Record<string, unknown>) {
    if (!draft) return;

    const result = (await selecta.call('drafts.edit', {
      draft_id: draftId,
      revision: draft.revision,
      ...change,
    })) as DraftView;

    if (result.error) {
      setNotice([result.error, result.hint].filter(Boolean).join(' '));
      await load();
    } else setView(result);
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
    await selecta.call('agent.send', { draft_id: draftId, message });
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
            defaultValue={draft.name}
            key={draft.revision}
            disabled={saved}
            onBlur={(e) =>
              e.target.value.trim() !== draft.name && edit({ name: e.target.value.trim() })
            }
          />
        ) : (
          <h1>Building…</h1>
        )}
        <button className="primary" disabled={!draft || saved || saving || working} onClick={save}>
          {saving ? 'Saving…' : saveLabel(draft?.save)}
        </button>
      </header>
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
                draggable={!saved}
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
                  disabled={saved || items.length === 1}
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
                <button className="primary" disabled={!feedback.trim() || saved}>
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
