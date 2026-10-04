// The draft screen: the rail, Claude's panel, and Save. Every edit goes
// through one queue (`edits.ts`); the rail only shows the order a queued edit
// will write until that edit settles.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { selecta } from '../api.js';
import { onArtworkFailure, retryArtwork } from '../artwork.js';
import type { Rect } from '../flight.js';
import { editQueue, newestHold, type Change } from '../edits.js';
import { useReducedMotion } from '../hooks/motion.js';
import { withMoved } from '../reorder.js';
import {
  bpmSpan,
  feedbackMessage,
  move,
  pendingOrder,
  previewLinked,
  rows,
  saveLabel,
  saveOutcome,
  totals,
  type DraftView,
  type Row,
  type Run,
} from '../state.js';
import { ClaudePanel } from './ClaudePanel.js';
import { Crate, type CrateTrack } from './Crate.js';
import { Flight, type FlightPlan } from './Flight.js';
import { Rail, type Opening, type RailHandle } from './Rail.js';
import { Rolling } from './Rolling.js';
import { SaveConfirm, type SavePhase } from './SaveConfirm.js';
import { TopBar } from './TopBar.js';

type Current = NonNullable<DraftView['draft']>;

export function Draft({
  draftId,
  run,
  onStart,
  onSend,
  onBack,
}: {
  draftId: string;
  run?: Run;
  onStart: (brief: string) => Promise<unknown>;
  onSend: (text: string, message: string) => Promise<unknown>;
  onBack: () => void;
}) {
  const [view, setView] = useState<DraftView>();
  const log = run?.log ?? [];
  // The host records a request before answering it, so until the answer the run may not show it yet.
  const [asking, setAsking] = useState(false);
  const working = (run?.working ?? false) || asking;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string>();
  const [artProblem, setArtProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState<SavePhase>('closed');
  const [leaving, setLeaving] = useState(false);
  const [name, setName] = useState('');
  const [pending, setPending] = useState<string[]>();
  // The rail shows the new order at once; the newest of these clears it when its edit settles.
  const [hold] = useState(() => newestHold(setPending));
  const answer = useRef<(ok: boolean) => void>(undefined);
  const naming = useRef(false);
  // Only typing commits a name, so blurring never writes back a name Claude has since changed.
  const typed = useRef(false);
  // Edits queue behind each other on the newest revision, so the rename a blur
  // starts lands before the click that caused the blur.
  const latest = useRef<DraftView['draft']>(undefined);
  const [queue] = useState(() => editQueue<Current>(() => latest.current, write));
  const rail = useRef<RailHandle>(null);
  const reduced = useReducedMotion();
  const [opening, setOpening] = useState<Opening>();
  const [flight, setFlight] = useState<FlightPlan & { at: number }>();
  const [added, setAdded] = useState('');

  const load = useCallback(
    () =>
      selecta.call('drafts.get', { draft_id: draftId }).then(
        (value) => show(value as DraftView),
        (e: Error) => setNotice(e.message),
      ),
    [draftId],
  );

  useEffect(() => {
    load();

    return selecta.on((event) => event.event === 'drafts.changed' && load());
  }, [load]);

  useEffect(() => onArtworkFailure(setArtProblem), []);

  const draft = view?.draft;
  const items = pendingOrder(rows(view ?? {}), pending);
  const saved = draft?.save !== undefined;
  const linked = previewLinked(view ?? {});
  const locked = saved || linked || saving || leaving;
  const sum = totals(items);
  const inDraft = useMemo(() => new Set(items.map((row) => row.track_id)), [items]);
  // One record in the air at a time, so each lands in the gap held for it.
  const canAdd = draft !== undefined && !locked && flight === undefined;
  // A record in the air is an edit not yet queued, so Save and Home wait for it to land.
  const airborne = flight !== undefined;
  const span = bpmSpan(items);

  // Live revisions keep arriving from Claude; don't overwrite a name being typed.
  useEffect(() => {
    if (draft && !naming.current) setName(draft.name);
  }, [draft]);

  function show(next: DraftView) {
    latest.current = next.draft;
    setView(next);
  }

  // Revision checks mean a stale edit fails rather than clobbering Claude's.
  async function write(base: Current, args: Record<string, unknown>) {
    try {
      const result = (await selecta.call('drafts.edit', {
        draft_id: draftId,
        revision: base.revision,
        ...args,
      })) as DraftView;

      if (!result.error) {
        show(result);

        return true;
      }

      setNotice([result.error, result.hint].filter(Boolean).join(' '));
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    }

    return false;
  }

  const edit = (change: Change<Current>) => queue.edit(change);

  const setEntries = (change: (entries: Row[]) => Row[] | undefined) =>
    edit((current) => {
      const next = change(current.entries);

      return next?.length
        ? { entries: next.map(({ entry_id, track_id }) => ({ entry_id, track_id })) }
        : undefined;
    });

  // Both ends are resolved by entry ID when the edit runs; earlier queued edits may have moved them.
  const moveEntry = (entryId: string, targetId: string) =>
    setEntries((entries) => {
      const from = entries.findIndex((entry) => entry.entry_id === entryId);
      const to = entries.findIndex((entry) => entry.entry_id === targetId);

      return from < 0 || to < 0 ? undefined : move(entries, from, to);
    });

  // The entry standing at `to` now is where `move` puts the dragged one.
  function reorder(entryId: string, to: number) {
    if (locked) return;

    const ids = items.map((row) => row.entry_id);

    hold(withMoved(ids, entryId, to), moveEntry(entryId, ids[to]));
  }

  function remove(entryId: string) {
    // A draft keeps at least one entry; the store would refuse an empty one anyway.
    if (locked || items.length < 2) return;

    hold(
      items.map((row) => row.entry_id).filter((id) => id !== entryId),
      setEntries((entries) => entries.filter((other) => other.entry_id !== entryId)),
    );
  }

  // A carried record holds a gap open wherever it would land.
  function carry(x: number, y: number) {
    const landing = rail.current?.landing(x, y, opening?.at);

    if (landing?.at !== opening?.at) setOpening(landing && { at: landing.at });

    return landing;
  }

  // The record flies to its slot first, and the edit goes in only once it has landed there.
  function add(track: CrateTrack, from: Rect, at = items.length) {
    if (!canAdd) return;

    const known = new Set(items.map((row) => row.entry_id));

    // The gap has to be on the rail before its box can be measured and scrolled to.
    flushSync(() => setOpening({ at, trackId: track.persistent_id, known }));

    const to = rail.current?.slotRect(at);

    if (to)
      setFlight({
        key: Date.now(),
        trackId: track.persistent_id,
        title: track.title,
        from,
        to,
        at,
      });
    else insert(track.persistent_id, at, track.title);
  }

  function insert(trackId: string, at: number, title?: string) {
    edit((current) => {
      const entries = current.entries.map(({ entry_id, track_id }) => ({ entry_id, track_id }));

      entries.splice(Math.min(at, entries.length), 0, {
        track_id: trackId,
      } as (typeof entries)[number]);

      return { entries };
    }).then((landed) => {
      setFlight(undefined);
      setOpening(undefined);

      if (landed) setAdded(`${title ?? 'Track'} added at ${at + 1}`);
    });
  }

  function toggle(entryId: string) {
    setSelected((current) => {
      const next = new Set(current);

      if (!next.delete(entryId)) next.add(entryId);

      return next;
    });
  }

  function send(text: string) {
    setAsking(true);

    // A build that failed before creating the draft has nothing to revise.
    const request = draft
      ? onSend(
          text,
          feedbackMessage(
            text,
            items.filter((row) => selected.has(row.entry_id)),
          ),
        )
      : onStart(text);

    request.finally(() => setAsking(false));
  }

  // Leaving locks the controls and waits for queued edits, and stays put if
  // one didn't land so its notice is seen.
  function back() {
    if (airborne) return;

    setLeaving(true);
    queue.landed().then((landed) => (landed ? onBack() : setLeaving(false)));
  }

  // Save is a barrier in the edit queue: controls lock on the click, and it
  // runs only if every edit still pending at the click landed.
  function save() {
    if (airborne) return;

    setSaving(true);

    return queue.barrier(commit).finally(() => {
      setSaving(false);
      setPhase('closed');
    });
  }

  // Asked once the queue has drained, so the card names what will really be written.
  const confirm = () =>
    new Promise<boolean>((resolve) => {
      answer.current = resolve;
      setPhase('confirm');
    });

  const respond = useCallback((ok: boolean) => {
    answer.current?.(ok);
    answer.current = undefined;
    setPhase(ok ? 'saving' : 'closed');
  }, []);

  async function commit() {
    const current = latest.current;

    if (!current || !(await confirm())) return;

    try {
      const result = (await selecta.call('drafts.save', {
        draft_id: draftId,
        revision: current.revision,
      })) as DraftView & { result?: Record<string, unknown> };

      setNotice(saveOutcome(result));
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  // Why the rail is locked, in the head where the drag hint would be.
  const lock = linked
    ? 'Read-only while linked'
    : phase === 'confirm'
      ? 'Locked while you confirm the save'
      : saving
        ? 'Saving to Music'
        : saved
          ? `${saveLabel(draft?.save)}, so the order is fixed here`
          : leaving
            ? 'Finishing your edits'
            : undefined;

  return (
    <div className="screen-draft">
      <TopBar
        onHome={back}
        homeDisabled={saving || leaving || airborne}
        crumb={
          draft ? (
            <>
              <input
                className="crumb-name"
                aria-label="Playlist name"
                value={name}
                disabled={locked}
                onChange={(e) => {
                  typed.current = true;
                  setName(e.target.value);
                }}
                onFocus={() => (naming.current = true)}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                onBlur={() => {
                  const next = typed.current && name.trim();

                  naming.current = false;
                  typed.current = false;

                  if (next && next !== draft.name) edit(() => ({ name: next }));
                  else setName(draft.name);
                }}
              />
              <span className="rev mono">rev {draft.revision}</span>
            </>
          ) : (
            <h1 className="crumb-title">{working ? 'Building…' : 'No draft yet'}</h1>
          )
        }
        right={
          <SaveConfirm
            phase={phase}
            label={saving && phase !== 'confirm' ? 'Saving…' : saveLabel(draft?.save)}
            disabled={!draft || locked || working || airborne}
            done={saved}
            name={draft?.name ?? ''}
            tracks={sum.tracks}
            minutes={sum.minutes}
            partial={sum.partial}
            onSave={save}
            onAnswer={respond}
          />
        }
      />
      <div className="draft-body">
        <section className="draft-main" aria-label="Draft">
          <Crate
            inDraft={inDraft}
            canAdd={canAdd}
            lockedReason={
              lock ?? (draft ? 'One record at a time' : 'The draft is still being built')
            }
            onAdd={add}
            onCarry={carry}
            onCarryEnd={() => setOpening(undefined)}
          />
          <div className="draft-head">
            <h2>The draft</h2>
            {draft && (
              <span className="totals mono">
                <Rolling value={sum.tracks} /> tracks · <Rolling value={sum.minutes} />
                {sum.partial ? '+' : ''} min
                {span && (
                  <>
                    {' '}
                    · <Rolling value={span[0]} />
                    {span[1] !== span[0] && (
                      <>
                        –<Rolling value={span[1]} />
                      </>
                    )}{' '}
                    BPM
                  </>
                )}
              </span>
            )}
            <span className={lock ? 'draft-hint locked' : 'draft-hint'}>
              {lock && (
                <svg viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="1.5" y="4.5" width="7" height="5" rx="1" />
                  <path d="M3 4.5V3a2 2 0 0 1 4 0v1.5" />
                </svg>
              )}
              {lock ?? 'Drag to reorder · Alt + arrows on a focused record · Delete removes'}
            </span>
          </div>
          {linked && (
            <p className="notice bar">
              This draft is linked to the Selecta Preview playlist in Music, so it's read-only here.
              Detach the preview where you started it to edit.
            </p>
          )}
          {notice && (
            <button
              type="button"
              className="notice bar dismiss"
              onClick={() => setNotice(undefined)}
            >
              {notice}
              <span className="mono">dismiss</span>
            </button>
          )}
          {artProblem && (
            <button
              type="button"
              className="notice bar dismiss"
              onClick={() => {
                setArtProblem(undefined);
                retryArtwork();
              }}
            >
              Album art unavailable: {artProblem}
              <span className="mono">try again</span>
            </button>
          )}
          <Rail
            items={items}
            selected={selected}
            locked={locked}
            onToggle={toggle}
            onClear={() => setSelected(new Set())}
            onMove={reorder}
            onRemove={remove}
            opening={opening}
            handle={rail}
            empty={
              <div className="rail-wait">
                {working ? (
                  <>
                    <b>Claude is pulling records</b>
                    <span>They stand on the rail as soon as the draft exists.</span>
                  </>
                ) : (
                  <>
                    <b>No draft yet</b>
                    <span>Describe the playlist in the panel to try again.</span>
                  </>
                )}
              </div>
            }
          />
        </section>
        <p className="sr" aria-live="polite">
          {added}
        </p>
        {flight &&
          createPortal(
            <Flight
              plan={flight}
              reduced={reduced}
              onLanded={() => insert(flight.trackId, flight.at, flight.title)}
            />,
            document.body,
          )}
        <ClaudePanel
          log={log}
          working={working}
          hasDraft={draft !== undefined}
          locked={locked}
          selected={items.filter((row) => selected.has(row.entry_id))}
          onUnselect={toggle}
          onSend={send}
          onStop={() => selecta.call('agent.cancel', { draft_id: draftId })}
        />
      </div>
    </div>
  );
}
