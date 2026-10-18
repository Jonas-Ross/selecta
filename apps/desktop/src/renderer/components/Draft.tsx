// The draft screen: the crate or Listen above the rail, the player bar, Claude's
// panel, and Save. Every edit goes through one queue (`edits.ts`); the rail
// only shows the order a queued edit will write until that edit settles.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { selecta } from '../api.js';
import {
  PROVIDER_LABELS,
  type ProviderId,
  type ProviderStatus,
  type Suggestion,
} from '../../shared/protocol.js';
import { onArtworkFailure, retryArtwork } from '../artwork.js';
import { runTools } from '../digging.js';
import type { Rect } from '../flight.js';
import { editQueue, newestHold, type Change } from '../edits.js';
import { useReducedMotion } from '../hooks/motion.js';
import { useListen } from '../hooks/useListen.js';
import { usePalette } from '../palette.js';
import { onMeasured } from '../hooks/useMeasure.js';
import { useReplace } from '../hooks/useReplace.js';
import { useSettings } from '../hooks/useSettings.js';
import { withMoved } from '../reorder.js';
import { around, site, swapEdit, swapEntries } from '../replace.js';
import {
  bpmSpan,
  feedbackMessage,
  move,
  nextPending,
  pendingOrder,
  previewLinked,
  previewOutOfStep,
  rows,
  saveHolds,
  saveLabel,
  saveOutcome,
  totals,
  type DraftView,
  type Pending,
  type Row,
  type Run,
} from '../state.js';
import { Banner } from './Banner.js';
import { Bench } from './Bench.js';
import { ClaudePanel } from './ClaudePanel.js';
import { Crate, type CrateTrack } from './Crate.js';
import { Digging } from './Digging.js';
import { Flight, type FlightPlan } from './Flight.js';
import { Groove } from './Groove.js';
import { Listen } from './Listen.js';
import { ListeningMode } from './ListeningMode.js';
import { Rail, type Opening, type RailHandle } from './Rail.js';
import { RecordMenu } from './RecordMenu.js';
import { Rolling } from './Rolling.js';
import { SaveConfirm, type SavePhase } from './SaveConfirm.js';
import { Shortlist } from './Shortlist.js';
import { TopBar } from './TopBar.js';
import { Transport } from './Transport.js';

// Preview states that mean Music.app may not hold what the draft says.

type Current = NonNullable<DraftView['draft']>;

export function Draft({
  draftId,
  run,
  by,
  onPick,
  onStart,
  onSend,
  onBack,
}: {
  draftId: string;
  run?: Run;
  /** Who answers the next message: the one picked here, else whoever answered last. */
  by: ProviderId;
  onPick: (id: ProviderId) => void;
  onStart: (brief: string) => Promise<unknown>;
  onSend: (text: string, message: string) => Promise<unknown>;
  onBack: () => void;
}) {
  const [view, setView] = useState<DraftView>();
  const log = run?.log ?? [];
  const tools = runTools(log);
  const agent = PROVIDER_LABELS[by];
  const { settings, update } = useSettings();
  const chatCollapsed = settings.chat === 'collapsed';
  const collapseChat = (collapsed: boolean) => update({ chat: collapsed ? 'collapsed' : 'open' });
  const [choices, setChoices] = useState<ProviderStatus[]>();
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
  const [pending, setPending] = useState<Pending>();
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
  const [tab, setTab] = useState<'dig' | 'listen'>('dig');
  const [full, setFull] = useState(false);
  const [menu, setMenu] = useState<{ entryId: string; x: number; y: number }>();
  const [swapped, setSwapped] = useState<{ text: string; undo?: () => void }>();
  const replace = useReplace(draftId, () => by, setNotice);
  const replacing = replace.state;
  const closeMenu = useCallback(() => setMenu(undefined), []);

  // Reads overlap when changes come quickly; only the newest one asked is shown.
  const loads = useRef(0);
  const load = useCallback(() => {
    const mine = ++loads.current;

    return selecta.call('drafts.get', { draft_id: draftId }).then(
      (value) => mine === loads.current && show(value as DraftView),
      (e: Error) => mine === loads.current && setNotice(e.message),
    );
  }, [draftId]);

  useEffect(() => {
    void load();

    const stopMeasured = onMeasured(() => void load());
    const stopEvents = selecta.on((event) => {
      if (event.event === 'drafts.changed') void load();
    });

    return () => {
      stopMeasured();
      stopEvents();
    };
  }, [load]);

  useEffect(() => onArtworkFailure(setArtProblem), []);

  // Without the list the panel just names the agent; the host still says what's missing.
  useEffect(() => {
    selecta.call('agent.providers').then(setChoices, () => {});
  }, []);

  const draft = view?.draft;
  const items = pendingOrder(rows(view ?? {}), pending);
  const saved = draft?.save !== undefined;
  const saveHeld = saveHolds(draft);
  const linked = previewLinked(view ?? {});
  const locked = saveHeld || saving || leaving;
  const sum = totals(items);
  const inDraft = useMemo(() => new Set(items.map((row) => row.track_id)), [items]);
  // A record in the air is an edit not yet queued, so Save and Home wait for it to land.
  const airborne = flight !== undefined;
  const span = bpmSpan(items);
  const grooveRecords = items.map((row) => ({ id: row.track_id, seconds: row.duration_seconds }));
  const sides = replacing && around(items, replacing.entryId);
  // Not while Claude runs: linking the draft mid-run would refuse its edits partway through.
  const canPlay =
    draft !== undefined && !working && !saving && !leaving && !airborne && phase === 'closed';
  const listen = useListen({
    draftId,
    items,
    latest: () => latest.current,
    queue,
    // Linked, Music may be playing this draft whatever the tab, after a remount or mid-sync too.
    // Not before the draft exists, since the state read needs it.
    watching: draft !== undefined && (tab === 'listen' || linked),
    linked,
    canPlay,
  });
  const { player } = listen;
  // Both stay mounted, so flipping crossfades instead of rebuilding the crate from empty.
  const band = replacing?.view === 'bench' && sides ? 'bench' : tab;
  // Listen lights the grooves in the colours of the record it shows, cued or playing.
  const tint = usePalette(
    tab === 'listen' && replacing?.view !== 'bench' ? listen.nowRow?.track_id : undefined,
  );
  // One record in the air at a time, so each lands in the gap held for it.
  const canAdd = draft !== undefined && !locked && !airborne && !replacing;
  // The rail holds a gap for the flying record at a fixed slot, so nothing else moves until it lands.
  // While replacing, the record in question stays where its neighbours are.
  const railLocked = locked || airborne || replacing !== undefined;
  // Not while the agent edits the draft, or while an edit is still settling on the rail.
  const canReplace = draft !== undefined && !railLocked && !working && pending === undefined;
  const recordRect = useCallback(
    () => (replacing ? rail.current?.recordRect(replacing.entryId) : undefined),
    [replacing?.entryId],
  );
  const outOfStep = linked && previewOutOfStep(view ?? {});

  // A record that left the draft has nothing left to replace, and picks for neighbours another
  // front end has since changed no longer fit where they would go.
  const pickedFor = useRef<string>(undefined);

  useEffect(() => {
    if (!replacing) return void (pickedFor.current = undefined);

    if (!sides) return replace.close();

    pickedFor.current ??= site(sides);

    if (pickedFor.current !== site(sides)) {
      replace.close();
      setNotice('The records around it changed, so Replace closed.');
    }
  });

  useEffect(() => {
    if (!replacing) return;

    const escape = (e: KeyboardEvent) => e.key === 'Escape' && replace.close();

    addEventListener('keydown', escape);

    return () => removeEventListener('keydown', escape);
  }, [replacing !== undefined, replace.close]);

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
    if (railLocked) return;

    const ids = items.map((row) => row.entry_id);

    hold(nextPending(pending, withMoved(ids, entryId, to), ids), moveEntry(entryId, ids[to]!));
  }

  function remove(entryId: string) {
    // A draft keeps at least one entry; the store would refuse an empty one anyway.
    if (railLocked || items.length < 2) return;

    const ids = items.map((row) => row.entry_id);

    hold(
      nextPending(
        pending,
        ids.filter((id) => id !== entryId),
        ids,
      ),
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
    void edit((current) => {
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

  // The new track goes in as a new entry where the old one stood; Undo swaps it back the same way.
  function swap(pick: Suggestion) {
    const target = replacing && items.find((row) => row.entry_id === replacing.entryId);

    if (!target) return;

    const swapping = swapEdit(target.entry_id, pick.track.persistent_id);
    let gone = false;

    replace.close();
    setSwapped(undefined);
    void edit((current) => {
      const entries = swapping.change(current.entries);

      gone = !entries;

      return entries && { entries };
    }).then((landed) => {
      if (!landed) return;

      if (gone) return setNotice('That record is no longer in the draft.');

      const added = swapping.added(latest.current?.entries ?? []);
      const text = `Swapped ${target.title ?? 'a record'} for ${pick.track.title ?? 'a new one'}`;

      setAdded(text);
      setSwapped({
        text,
        undo:
          added === undefined
            ? undefined
            : () => {
                setSwapped(undefined);
                void edit((current) => {
                  const entries = swapEntries(current.entries, added, target.track_id);

                  return entries && { entries };
                });
              },
      });
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
    const ask = () =>
      draft
        ? onSend(
            text,
            feedbackMessage(
              text,
              items.filter((row) => selected.has(row.entry_id)),
            ),
          )
        : onStart(text);
    // Feedback waits for queued edits, so a host stopping the music names the revision they left.
    const request = draft ? queue.after(ask) : ask();

    void request.finally(() => setAsking(false));
  }

  // Leaving locks the controls and waits for queued edits, and stays put if
  // one didn't land so its notice is seen.
  function back() {
    if (airborne) return;

    setLeaving(true);
    void queue.landed().then((landed) => (landed ? onBack() : setLeaving(false)));
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
    if (!latest.current || !(await confirm())) return;

    // The card re-renders as Claude's late edits arrive, so the revision approved is the one it shows now.
    const current = latest.current;

    if (!current) return;

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
  const lock =
    phase === 'confirm'
      ? 'Confirming the save'
      : saving
        ? 'Saving to Music'
        : saveHeld
          ? saveLabel(draft?.save)
          : leaving
            ? 'Finishing your edits'
            : replacing
              ? 'Replacing a record'
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

                  if (next && next !== draft.name) void edit(() => ({ name: next }));
                  else setName(draft.name);
                }}
              />
            </>
          ) : (
            <h1 className="crumb-title">{working ? 'Building…' : 'No draft yet'}</h1>
          )
        }
        right={
          <SaveConfirm
            phase={phase}
            label={
              saving && phase !== 'confirm'
                ? 'Saving…'
                : saveLabel(draft?.save, draft?.playlist !== undefined)
            }
            disabled={!draft || saved || locked || working || airborne}
            done={saved}
            name={draft?.name ?? ''}
            target={draft?.playlist?.name}
            tracks={sum.tracks}
            minutes={sum.minutes}
            partial={sum.partial}
            onSave={() => void save()}
            onAnswer={respond}
          />
        }
      />
      <div className="draft-body">
        <div className="draft-ground">
          <Groove
            records={grooveRecords}
            now={listen.current ? listen.now : undefined}
            playing={listen.playing}
            progress={listen.duration ? listen.position / listen.duration : undefined}
            tint={tint}
          />
        </div>
        <section className="draft-main" aria-label="Draft">
          <div className="mode-band">
            <div className={band === 'dig' ? 'mode-layer on' : 'mode-layer'} inert={band !== 'dig'}>
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
            </div>
            <div
              className={band === 'listen' ? 'mode-layer on' : 'mode-layer'}
              inert={band !== 'listen'}
            >
              <Listen
                items={items}
                now={listen.now}
                playing={listen.playing}
                current={listen.current}
                position={listen.position}
                status={listen.status}
                joinDisabled={!canPlay || !listen.canJoin}
                onJoin={listen.join}
              />
            </div>
            {band === 'bench' && sides && (
              <div className="mode-layer on">
                <Bench around={sides} replace={replace} agent={agent} onSwap={swap} />
              </div>
            )}
          </div>
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
            {replacing && sides && (
              <span className="mode-rep">
                Replacing {sides.row.title ?? 'a record'}
                <button type="button" aria-label="Stop replacing" onClick={replace.close}>
                  <svg viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
                  </svg>
                </button>
              </span>
            )}
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
                  ? 'Click to play · drag to reorder'
                  : 'Drag to reorder · right-click to replace')}
            </span>
          </div>
          <Banner value={outOfStep}>
            {() => (
              <p className="notice bar error">
                Music may be playing an old copy of this draft. Stop, then play again.
              </p>
            )}
          </Banner>
          <Banner value={player.problem}>
            {(problem) => (
              <button type="button" className="notice bar dismiss" onClick={player.dismiss}>
                Music.app: {problem}
                <span className="mono">dismiss</span>
              </button>
            )}
          </Banner>
          <Banner value={notice}>
            {(text) => (
              <button
                type="button"
                className="notice bar dismiss"
                onClick={() => setNotice(undefined)}
              >
                {text}
                <span className="mono">dismiss</span>
              </button>
            )}
          </Banner>
          <Banner value={swapped}>
            {({ text, undo }) => (
              <p className="notice bar" role="status">
                {text}
                {undo && (
                  <button type="button" className="btn line sm" onClick={undo}>
                    Undo
                  </button>
                )}
                <button type="button" className="mono" onClick={() => setSwapped(undefined)}>
                  dismiss
                </button>
              </p>
            )}
          </Banner>
          <Banner value={artProblem}>
            {(problem) => (
              <button
                type="button"
                className="notice bar dismiss"
                onClick={() => {
                  setArtProblem(undefined);
                  retryArtwork();
                }}
              >
                Album art unavailable: {problem}
                <span className="mono">try again</span>
              </button>
            )}
          </Banner>
          <Rail
            items={items}
            selected={selected}
            locked={railLocked}
            onToggle={
              tab === 'listen'
                ? (entryId) => listen.cue(items.findIndex((row) => row.entry_id === entryId))
                : toggleSelected
            }
            pickVerb={tab === 'listen' ? 'plays it' : 'selects'}
            now={listen.current ? listen.nowRow?.entry_id : undefined}
            onClear={() => setSelected(new Set())}
            onMove={reorder}
            onRemove={remove}
            opening={opening}
            handle={rail}
            replacing={replacing?.entryId}
            onMenu={(entryId, x, y) => !replacing && setMenu({ entryId, x, y })}
            empty={(shelf, width) =>
              working ? (
                <Digging
                  agent={agent}
                  shelf={shelf}
                  view={width}
                  tool={tools.at(-1)}
                  calls={tools.length}
                />
              ) : (
                <div className="rail-wait">
                  <b>No draft yet</b>
                  <span>Try again in the {agent} panel.</span>
                </div>
              )
            }
          />
          <Transport
            row={listen.nowRow}
            index={listen.now}
            count={items.length}
            playing={listen.playing}
            pending={listen.pending}
            position={listen.position}
            duration={listen.duration}
            set={{
              ...listen.setTime,
              total: listen.whole.elapsed,
              totalPartial: listen.whole.partial,
            }}
            disabled={!canPlay}
            canPrev={listen.canPrev}
            canNext={listen.now + 1 < items.length}
            onToggle={listen.toggle}
            onPrev={listen.prev}
            onNext={listen.next}
            onSeek={listen.current ? (position) => void player.seek(position) : undefined}
            onOpen={tab === 'listen' ? undefined : () => setTab('listen')}
            onFull={
              replacing
                ? undefined
                : () => {
                    setTab('listen');
                    setFull(true);
                  }
            }
            onStop={linked ? listen.stop : undefined}
            stopDisabled={saving}
          />
        </section>
        <p className="sr" aria-live="polite">
          {added}
        </p>
        {menu && (
          <RecordMenu
            x={menu.x}
            y={menu.y}
            title={items.find((row) => row.entry_id === menu.entryId)?.title ?? 'Record'}
            onClose={closeMenu}
            items={[
              {
                label: 'Replace…',
                disabled: !canReplace,
                run: () => replace.open(menu.entryId),
              },
              {
                label: selected.has(menu.entryId) ? 'Deselect' : 'Select for feedback',
                run: () => toggleSelected(menu.entryId),
              },
              {
                label: 'Remove',
                key: '⌫',
                disabled: railLocked || items.length < 2,
                run: () => remove(menu.entryId),
              },
            ]}
          />
        )}
        {replacing?.view === 'list' && sides && (
          <Shortlist
            anchor={recordRect}
            around={sides}
            replace={replace}
            agent={agent}
            onSwap={swap}
          />
        )}
        {full && (
          <ListeningMode
            name={draft?.name ?? ''}
            items={items}
            listen={listen}
            disabled={!canPlay}
            joinDisabled={!canPlay || !listen.canJoin}
            onClose={() => setFull(false)}
          />
        )}
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
          draftId={draftId}
          by={by}
          choices={choices}
          onPick={onPick}
          log={log}
          working={working}
          hasDraft={draft !== undefined}
          locked={locked || replacing !== undefined}
          listening={linked}
          selected={items.filter((row) => selected.has(row.entry_id))}
          onUnselect={toggleSelected}
          onSend={send}
          onStop={() => void selecta.call('agent.cancel', { draft_id: draftId })}
          collapsed={chatCollapsed}
          onCollapse={collapseChat}
        />
      </div>
    </div>
  );
}
