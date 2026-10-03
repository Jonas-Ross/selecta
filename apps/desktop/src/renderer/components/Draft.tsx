// The draft screen: the crate or Listen above the rail, the player bar, Claude's
// panel, and Save. Every edit goes through one queue on the newest revision;
// the rail only shows the order a queued edit will write until that edit settles.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { selecta } from '../api.js';
import { onArtworkFailure, retryArtwork } from '../artwork.js';
import type { Rect } from '../flight.js';
import { elsewhere, joinStart, livePosition, nowIndex, setClock } from '../listen.js';
import { usePlayer } from '../player.js';
import { useReducedMotion } from '../motion.js';
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
import { Listen } from './Listen.js';
import { Rail, type Opening, type RailHandle } from './Rail.js';
import { Rolling } from './Rolling.js';
import { SaveConfirm, type SavePhase } from './SaveConfirm.js';
import { TopBar } from './TopBar.js';
import { Transport } from './Transport.js';

// Back past this many seconds restarts the record, as a player's previous button does.
const RESTART_AFTER = 4;
// Preview states that mean Music.app may not hold what the draft says.
const OUT_OF_STEP = new Set(['pending', 'conflict', 'error', 'uncertain']);

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
  const pendingToken = useRef(0);
  const answer = useRef<(ok: boolean) => void>(undefined);
  const naming = useRef(false);
  // Only typing commits a name, so blurring never writes back a name Claude has since changed.
  const typed = useRef(false);
  // Edits queue behind each other on the newest revision, so the rename a blur
  // starts lands before the click that caused the blur.
  const latest = useRef<DraftView['draft']>(undefined);
  const edits = useRef<Promise<unknown>>(Promise.resolve());
  // Edits not yet settled, each resolving to whether it landed; a Save waits on these.
  const inflight = useRef(new Set<Promise<boolean>>());
  const rail = useRef<RailHandle>(null);
  const reduced = useReducedMotion();
  const [opening, setOpening] = useState<Opening>();
  const [flight, setFlight] = useState<FlightPlan & { at: number }>();
  const [added, setAdded] = useState('');
  const [tab, setTab] = useState<'dig' | 'listen'>('dig');
  const [cued, setCued] = useState<string>();
  const player = usePlayer(draftId, tab === 'listen');
  const [clock, setClockNow] = useState(() => performance.now());

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
  const locked = saved || saving || leaving;
  const sum = totals(items);
  const inDraft = useMemo(() => new Set(items.map((row) => row.track_id)), [items]);
  // One record in the air at a time, so each lands in the gap held for it.
  const canAdd = draft !== undefined && !locked && flight === undefined;
  // A record in the air is an edit not yet queued, so Save and Home wait for it to land.
  const airborne = flight !== undefined;
  const span = bpmSpan(items);
  const live = player.view;
  const now = nowIndex(items, live, cued);
  const nowRow = items[now];
  const current = live?.entry_id !== undefined && live.entry_id === nowRow?.entry_id;
  const playing = current && live?.state === 'playing';
  const position = current ? livePosition(live, player.readAt, clock) : 0;
  // Not while Claude runs: linking the draft mid-run would refuse its edits partway through.
  const canPlay =
    draft !== undefined && !working && !saving && !leaving && !airborne && phase === 'closed';
  const outOfStep = linked && OUT_OF_STEP.has(view?.preview?.status ?? '');

  // Music.app is read about once a second; the bar moves smoothly in between.
  useEffect(() => {
    if (!playing) return;

    const timer = setInterval(() => setClockNow(performance.now()), 250);

    return () => clearInterval(timer);
  }, [playing]);

  // Live revisions keep arriving from Claude; don't overwrite a name being typed.
  useEffect(() => {
    if (draft && !naming.current) setName(draft.name);
  }, [draft]);

  function show(next: DraftView) {
    latest.current = next.draft;
    setView(next);
  }

  type Change = (draft: NonNullable<DraftView['draft']>) => Record<string, unknown> | undefined;

  // A change is worked out from the draft as it stands when its turn comes, so
  // queued clicks compose instead of replaying the snapshot they were made on.
  function edit(change: Change): Promise<boolean> {
    const next = edits.current.then(() => apply(change));

    edits.current = next;
    inflight.current.add(next);
    next.finally(() => inflight.current.delete(next));

    return next;
  }

  // Revision checks mean a stale edit fails rather than clobbering Claude's.
  async function apply(change: Change): Promise<boolean> {
    const base = latest.current;
    const args = base && change(base);

    if (!base || !args) return true;

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

  // The rail shows the new order at once; the newest of these clears it when its edit settles.
  function hold(order: string[], landing: Promise<boolean>) {
    const token = ++pendingToken.current;

    setPending(order);
    landing.finally(() => pendingToken.current === token && setPending(undefined));
  }

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

  function toggleSelected(entryId: string) {
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
    Promise.all(inflight.current).then((landed) =>
      landed.every(Boolean) ? onBack() : setLeaving(false),
    );
  }

  // Save is a barrier in the edit queue: controls lock on the click, and it
  // runs only if every edit still pending at the click landed.
  function save() {
    if (airborne) return;

    setSaving(true);

    const ahead = [...inflight.current];
    const step = edits.current
      .then(() => Promise.all(ahead))
      .then((landed) => (landed.every(Boolean) ? commit() : undefined))
      .finally(() => {
        setSaving(false);
        setPhase('closed');
      });

    edits.current = step;

    return step;
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

  // Plays wait for queued edits, so the revision they name is the one the rail shows.
  function playAt(entryId: string, at?: number) {
    if (!canPlay) return;

    edits.current = edits.current.then(() => {
      const revision = latest.current?.revision;

      if (revision !== undefined) return player.play(revision, entryId, at);
    });
  }

  function toggle() {
    if (!nowRow) return;

    if (!current) playAt(nowRow.entry_id);
    else if (playing) player.pause();
    else player.resume();
  }

  // Moving while Music.app is on this draft plays there; otherwise it only moves the cue.
  function cue(index: number) {
    const row = items[index];

    if (!row) return;

    setCued(row.entry_id);

    if (current) playAt(row.entry_id);
  }

  function prev() {
    if (current && position > RESTART_AFTER) player.seek(0);
    else cue(now - 1);
  }

  function stopListening() {
    const revision = latest.current?.revision;

    if (revision !== undefined) player.detach(revision);
  }

  const status =
    elsewhere(live) ??
    (current
      ? 'Plays through Music.app from Selecta Preview. Your edits update it; Claude waits until you stop.'
      : linked
        ? 'Selecta Preview holds this draft. Press play, or stop to hand it back to Claude.'
        : 'Play loads the draft into Selecta Preview in Music.app.');
  const setTime = setClock(items, now, position);
  const whole = setClock(items, items.length, 0);

  // Why the rail is locked, in the head where the drag hint would be.
  const lock =
    phase === 'confirm'
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
          {tab === 'listen' ? (
            <Listen
              items={items}
              now={now}
              playing={playing}
              current={current}
              status={status}
              joinDisabled={!canPlay || player.busy || now + 1 >= items.length}
              onJoin={() => nowRow && playAt(nowRow.entry_id, joinStart(nowRow.duration_seconds))}
            />
          ) : (
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
          )}
          <div className="draft-head">
            <div className="modes" role="tablist" aria-label="Above the draft">
              {(['dig', 'listen'] as const).map((name) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={tab === name}
                  className={tab === name ? 'mode on' : 'mode'}
                  onClick={() => setTab(name)}
                >
                  {name === 'dig' ? 'Dig' : 'Listen'}
                </button>
              ))}
            </div>
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
              {lock ??
                (tab === 'listen'
                  ? 'Click a record to play it · drag to reorder'
                  : 'Drag to reorder · Alt + arrows on a focused record · Delete removes')}
            </span>
          </div>
          {outOfStep && (
            <p className="notice bar error">
              Selecta Preview in Music may not match this draft ({view?.preview?.status}). Stop
              listening to release it, then press play to load it again.
            </p>
          )}
          {player.problem && (
            <button type="button" className="notice bar dismiss" onClick={player.dismiss}>
              Music.app: {player.problem}
              <span className="mono">dismiss</span>
            </button>
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
            onToggle={
              tab === 'listen'
                ? (entryId) => cue(items.findIndex((row) => row.entry_id === entryId))
                : toggleSelected
            }
            pickVerb={tab === 'listen' ? 'plays it' : 'selects'}
            now={current ? nowRow?.entry_id : undefined}
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
          <Transport
            row={nowRow}
            index={now}
            count={items.length}
            playing={playing}
            position={position}
            duration={current ? live?.duration : undefined}
            set={{ ...setTime, total: whole.elapsed, totalPartial: whole.partial }}
            disabled={!canPlay || player.busy}
            canPrev={now > 0 || (current && position > RESTART_AFTER)}
            canNext={now + 1 < items.length}
            onToggle={toggle}
            onPrev={prev}
            onNext={() => cue(now + 1)}
            onSeek={current ? player.seek : undefined}
            onOpen={tab === 'listen' ? undefined : () => setTab('listen')}
            onStop={linked && !player.busy && !saving ? stopListening : undefined}
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
          locked={locked || linked}
          selected={items.filter((row) => selected.has(row.entry_id))}
          onUnselect={toggleSelected}
          onSend={send}
          onStop={() => selecta.call('agent.cancel', { draft_id: draftId })}
        />
      </div>
    </div>
  );
}
