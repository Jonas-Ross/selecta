// The draft's playback controller: which record is cued or playing, where it
// is, and the transport actions. Plays and stops wait on the draft's edit
// queue, so the revision they name is the one the rail shows.
import { useEffect, useRef, useState } from 'react';
import type { EditQueue } from '../edits.js';
import { elsewhere, joinStart, livePosition, nowIndex, queuePlay, setClock } from '../listen.js';
import type { DraftView, Row } from '../state.js';
import { usePlayer } from './usePlayer.js';

// Back past this many seconds restarts the record, as a player's previous button does.
const RESTART_AFTER = 4;

export function useListen({
  draftId,
  items,
  latest,
  queue,
  watching,
  linked,
  canPlay,
}: {
  draftId: string;
  items: Row[];
  /** The draft as last read, for the revision a queued play names. */
  latest: () => DraftView['draft'];
  queue: EditQueue<NonNullable<DraftView['draft']>>;
  /** Listen is open or the draft is linked, so Music may be playing it. */
  watching: boolean;
  linked: boolean;
  canPlay: boolean;
}) {
  const player = usePlayer(draftId, watching);
  const [cued, setCued] = useState<string>();
  const [clock, setClockNow] = useState(() => performance.now());
  // A play or stop waiting on the edit queue counts as busy, holding Claude and the transport
  // off as a running one does. The ref sees a second click in the same tick, before a re-render.
  const [queued, setQueued] = useState(false);
  const waiting = useRef(false);
  const allowed = useRef(canPlay);

  allowed.current = canPlay;
  const live = player.view;
  const now = nowIndex(items, live, cued);
  const nowRow = items[now];
  const current = live?.entry_id !== undefined && live.entry_id === nowRow?.entry_id;
  const playing = current && live?.state === 'playing';
  const position = current ? livePosition(live, player.readAt, clock) : 0;
  // Music's own length for the record it's on, else the cached one.
  // Music's own length for the record it's on, else the cached one.
  const joinAt =
    joinStart(current ? live?.duration : undefined) ?? joinStart(nowRow?.duration_seconds);

  // Music.app is read about once a second; the bar moves smoothly in between.
  useEffect(() => {
    if (!playing) return;

    const timer = setInterval(() => setClockNow(performance.now()), 250);

    return () => clearInterval(timer);
  }, [playing]);

  // One Music operation at a time; a second would fail busy or queue an extra route.
  function hold(step: () => Promise<unknown>) {
    if (player.busy || waiting.current) return;

    waiting.current = true;
    setQueued(true);
    void step().finally(() => {
      waiting.current = false;
      setQueued(false);
    });
  }

  function playAt(entryId: string, at?: number) {
    if (!canPlay) return;

    hold(() =>
      queuePlay(
        queue,
        () => allowed.current,
        () => latest()?.revision,
        (revision) => player.play(revision, entryId, at),
      ),
    );
  }

  // Moving while Music.app is on this draft plays there; otherwise it only moves the cue.
  function cue(index: number) {
    const row = items[index];

    if (!row) return;

    setCued(row.entry_id);

    if (current) playAt(row.entry_id);
  }

  const status =
    elsewhere(live) ??
    (current || linked ? 'Claude waits until you stop listening.' : 'Plays in Music.');

  return {
    player,
    busy: player.busy || queued,
    now,
    nowRow,
    current,
    playing,
    position,
    // Music.app reports an unset length as 0; the cached one stands in for it.
    duration: current ? live?.duration || nowRow?.duration_seconds : undefined,
    status,
    setTime: setClock(items, now, position),
    whole: setClock(items, items.length, 0),
    canPrev: now > 0 || (current && position > RESTART_AFTER),
    cue,
    toggle() {
      if (!nowRow) return;

      if (!current) playAt(nowRow.entry_id);
      else if (playing) player.pause();
      else player.resume();
    },
    prev() {
      if (current && position > RESTART_AFTER) player.seek(0);
      else cue(now - 1);
    },
    next: () => cue(now + 1),
    canJoin: joinAt !== undefined && now + 1 < items.length,
    join: () => nowRow && joinAt !== undefined && playAt(nowRow.entry_id, joinAt),
    // Waits like a play, so a stop never names a revision an edit is about to replace.
    stop() {
      hold(() =>
        queue.after(() => {
          const revision = latest()?.revision;

          if (revision !== undefined) return player.detach(revision);
        }),
      );
    },
  };
}
