// One lane for everything the app asks of Music.app. Calls run one at a time, so
// none fails busy on the music lock, and transport calls still waiting fold into
// the newest intent, so a burst of clicks costs Music one step, not a replay.
import type { AuditionView, Playback, PlaybackView } from '@selecta/core/operations/playback.js';

/** What a draft's waiting transport calls add up to: play an entry, or move and pause/resume. */
type Transport = {
  play?: { entryId: string; position?: number };
  seek?: number;
  run?: 'pause' | 'resume';
};

type Waiter = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

type Job = {
  // Jobs with a key can be dropped while they wait, and merged into when they have `merge`.
  key?: string;
  // The draft a job plays, writes or edits for, so its other calls know to wait their turn.
  draft?: string;
  merge?: (next: never) => void;
  // Named in the action log; reads polled every second go unnamed, so only their failures show.
  step?: () => string;
  queuedAt: number;
  run: () => Promise<unknown>;
  waiters: Waiter[];
};

const AUDITION = 'audition';
const transportKey = (draftId: string) => `transport ${draftId}`;
const syncKey = (draftId: string) => `sync ${draftId}`;

export type MusicLane = ReturnType<typeof createMusicLane>;

export function createMusicLane({
  player,
  syncLinked,
  log = () => {},
}: {
  player: Playback;
  /** Writes a linked draft's newest order into Selecta Preview, if it has fallen behind. */
  syncLinked: (draftId: string) => Promise<unknown>;
  /** One line per step Music took: how long it ran, how long it waited, how many calls it answered. */
  log?: (entry: {
    step: string;
    ms: number;
    waited: number;
    calls: number;
    error?: string;
  }) => void;
}) {
  const queue: Job[] = [];
  let running: Job | undefined;
  // What each call last saw, answered to polls while the lane is busy rather than racing it.
  const seen = new Map<string, { view: PlaybackView; at: number }>();
  let heard: AuditionView | undefined;

  const remember = (draftId: string, view: PlaybackView) => {
    seen.set(draftId, { view, at: Date.now() });

    return view;
  };

  // A playing answer moves on with the clock, so polls answered from it don't keep snapping back.
  function since(draftId: string): PlaybackView | undefined {
    const last = seen.get(draftId);

    if (!last || last.view.state !== 'playing' || last.view.position === undefined)
      return last?.view;

    const position = last.view.position + (Date.now() - last.at) / 1000;
    const { duration } = last.view;

    return { ...last.view, position: duration ? Math.min(position, duration) : position };
  }

  async function drain() {
    if (running) return;

    while ((running = queue.shift())) {
      const job = running;
      const started = Date.now();
      const note = (error?: unknown) =>
        (job.step || error) &&
        log({
          step: job.step?.() ?? 'read',
          ms: Date.now() - started,
          waited: started - job.queuedAt,
          calls: job.waiters.length,
          ...(error !== undefined && {
            error: error instanceof Error ? error.message : String(error),
          }),
        });

      try {
        const value = await job.run();

        note();

        for (const waiter of job.waiters) waiter.resolve(value);
      } catch (error) {
        note(error);

        for (const waiter of job.waiters) waiter.reject(error);
      }
    }
  }

  function push<T>(job: Omit<Job, 'waiters' | 'queuedAt'>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({
        ...job,
        queuedAt: Date.now(),
        waiters: [{ resolve: resolve as Waiter['resolve'], reject }],
      });
      void drain();
    });
  }

  // Folds `next` into the job at the back when it has `key`, so nothing queued after a call
  // ever runs before it. The joined job runs with whatever state the merge left it.
  function joined<T>(key: string, next: unknown): Promise<T> | undefined {
    const last = queue.at(-1);

    if (last?.key !== key || !last.merge) return undefined;

    (last.merge as (next: unknown) => void)(next);

    return new Promise<T>((resolve, reject) =>
      last.waiters.push({ resolve: resolve as Waiter['resolve'], reject }),
    );
  }

  // Drops waiting jobs, answering their callers with `value` since nothing of theirs will run.
  function drop(match: (job: Job) => boolean, value?: unknown) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const job = queue[i]!;

      if (!match(job)) continue;

      queue.splice(i, 1);

      for (const waiter of job.waiters) waiter.resolve(value);
    }
  }

  const busy = () => running !== undefined || queue.length > 0;

  // Joins a job with `key` still waiting, which reads what it needs when it runs.
  function waiting<T>(key: string): Promise<T> | undefined {
    const job = queue.find((j) => j.key === key);

    return (
      job &&
      new Promise<T>((resolve, reject) =>
        job.waiters.push({ resolve: resolve as Waiter['resolve'], reject }),
      )
    );
  }

  async function runTransport(draftId: string, t: Transport): Promise<PlaybackView> {
    try {
      return remember(draftId, await steps(draftId, t));
    } catch (error) {
      // Music got somewhere the last answer doesn't say; only a fresh read can.
      seen.delete(draftId);

      throw error;
    }
  }

  async function steps(draftId: string, t: Transport): Promise<PlaybackView> {
    if (t.play) {
      const view = await player.play(draftId, t.play.entryId, t.play.position);

      return t.run === 'pause' ? player.control(draftId, { action: 'pause' }) : view;
    }

    const last = seen.get(draftId)?.view;

    // A play and pause that met while waiting leave nothing to stop unless this draft was playing.
    if (t.run === 'pause' && !(last?.entry_id !== undefined && last.state === 'playing'))
      t = { ...t, run: undefined };

    let view: PlaybackView | undefined;

    if (t.run === 'pause') view = await player.control(draftId, { action: 'pause' });

    if (t.seek !== undefined)
      view = await player.control(draftId, { action: 'seek', position: t.seek });

    if (t.run === 'resume') view = await player.control(draftId, { action: 'resume' });

    // Calls that cancelled out leave the last answer standing, if there is one.
    return view ?? since(draftId) ?? player.state(draftId);
  }

  // The newest call decides: a play replaces what waits, a seek moves it, a pause and resume
  // cancel. A play paused while waiting still plays, so Music ends on the record the screen shows.
  function merge(t: Transport, next: Transport) {
    if (next.play) {
      t.play = next.play;
      t.seek = undefined;
      t.run = undefined;
    } else if (next.seek !== undefined) {
      if (t.play) t.play.position = next.seek;
      else t.seek = next.seek;
    } else if (next.run === 'pause') {
      t.run = t.run === 'resume' ? undefined : 'pause';
    } else if (next.run === 'resume') {
      t.run = t.run === 'pause' ? undefined : t.play ? undefined : 'resume';
    }
  }

  function transport(draftId: string, next: Transport): Promise<PlaybackView> {
    const key = transportKey(draftId);
    const folded = joined<PlaybackView>(key, next);

    if (folded) return folded;

    const t: Transport = {};

    merge(t, next);

    return push({
      key,
      draft: draftId,
      merge: (more: Transport) => merge(t, more),
      step: () =>
        t.play
          ? `play ${t.play.entryId}${t.play.position === undefined ? '' : ` at ${t.play.position}`}${t.run === 'pause' ? ', pause' : ''}`
          : [
              t.run === 'pause' && 'pause',
              t.seek !== undefined && `seek ${t.seek}`,
              t.run === 'resume' && 'resume',
            ]
              .filter(Boolean)
              .join(', ') || 'nothing left to do',
      run: () => runTransport(draftId, t),
    });
  }

  function audition(trackIds: string[], index: number, position?: number) {
    let args = { trackIds, index, position };
    // A waiting audition reads its tracks when it starts, so the newest replaces them.
    const folded = joined<AuditionView>(AUDITION, args);

    if (folded) return folded;

    return push<AuditionView>({
      key: AUDITION,
      merge: (next: typeof args) => (args = next),
      step: () => `audition ${args.index}`,
      run: async () => {
        // Music leaves whatever draft it was on for the audition.
        seen.clear();
        heard = await player.audition(args.trackIds, args.index, args.position);

        return heard;
      },
    });
  }

  // Drops what a draft still waits to play or write, which stopping makes moot.
  function forget(draftId: string) {
    drop((job) => job.key === transportKey(draftId) || job.key === syncKey(draftId));
    seen.delete(draftId);
  }

  return {
    /** Answered from the last call while the lane works, so a poll never waits behind a play. */
    state(draftId: string): Promise<PlaybackView> {
      const last = since(draftId);

      if (busy() && last) return Promise.resolve(last);

      const key = `read ${draftId}`;

      return (
        waiting<PlaybackView>(key) ??
        push({ key, run: async () => remember(draftId, await player.state(draftId)) })
      );
    },

    play: (draftId: string, entryId: string, position?: number) =>
      transport(draftId, { play: { entryId, ...(position !== undefined && { position }) } }),
    pause: (draftId: string) => transport(draftId, { run: 'pause' }),
    resume: (draftId: string) => transport(draftId, { run: 'resume' }),
    seek: (draftId: string, position: number) => transport(draftId, { seek: position }),

    detach(draftId: string, revisionAt: number) {
      forget(draftId);

      return push<void>({
        draft: draftId,
        step: () => 'detach',
        run: async () => {
          seen.delete(draftId);
          await player.detach(draftId, revisionAt);
        },
      });
    },

    forget,

    // Behind everything already asked, so an edit's order reaches Music before a play after it.
    sync(draftId: string) {
      const key = syncKey(draftId);

      // A sync at the back reads the draft when it runs, so it covers this edit too.
      return (
        joined(key, undefined) ??
        push({
          key,
          draft: draftId,
          merge: () => {},
          step: () => 'sync preview',
          run: () => syncLinked(draftId),
        })
      );
    },

    syncing: (draftId: string) =>
      running?.key === syncKey(draftId) || queue.some((job) => job.key === syncKey(draftId)),

    /** Something for this draft is playing, writing or waiting to. */
    holds: (draftId: string) =>
      running?.draft === draftId || queue.some((job) => job.draft === draftId),

    audition,

    auditionState(): Promise<AuditionView> {
      if (busy() && heard) return Promise.resolve(heard);

      return (
        waiting<AuditionView>('read audition') ??
        push({ key: 'read audition', run: async () => (heard = await player.auditionState()) })
      );
    },

    auditionStop() {
      drop((job) => job.key === AUDITION, { state: 'stopped' });

      return push<void>({
        step: () => 'stop audition',
        run: async () => {
          seen.clear();
          await player.stopAudition();
          heard = { state: 'stopped' };
        },
      });
    },

    /** Runs `step` in turn, for anything else that may write Music or depend on what it plays. */
    after: <T>(name: string, step: () => Promise<T> | T, draft?: string) =>
      push<T>({ step: () => name, draft, run: async () => step() }),
  };
}
