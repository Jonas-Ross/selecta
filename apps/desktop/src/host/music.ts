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
  // Jobs with a key can be merged with or dropped while they wait.
  key?: string;
  // Named in the action log; reads polled every second go unnamed, so only their failures show.
  step?: () => string;
  queuedAt?: number;
  transport?: Transport;
  audition?: { trackIds: string[]; index: number; position?: number };
  run: () => Promise<unknown>;
  waiters: Waiter[];
};

export type MusicLane = ReturnType<typeof createMusicLane>;

export function createMusicLane({
  player,
  revision,
  syncLinked,
  log = () => {},
}: {
  player: Playback;
  /** The draft's revision when its play runs, so an edit landing meanwhile doesn't refuse it. */
  revision: (draftId: string) => number;
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
  const seen = new Map<string, PlaybackView>();
  let heard: AuditionView | undefined;

  const remember = (draftId: string, view: PlaybackView) => {
    seen.set(draftId, view);

    return view;
  };

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
          waited: started - (job.queuedAt ?? started),
          calls: job.waiters.length,
          ...(error !== undefined && { error: (error as Error).message ?? String(error) }),
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

  function push<T>(job: Omit<Job, 'waiters'>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({
        ...job,
        queuedAt: Date.now(),
        waiters: [{ resolve: resolve as Waiter['resolve'], reject }],
      });
      void drain();
    });
  }

  // Joins a job still waiting; it runs with whatever state the merge left it.
  function join<T>(job: Job): Promise<T> {
    return new Promise<T>((resolve, reject) =>
      job.waiters.push({ resolve: resolve as Waiter['resolve'], reject }),
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
  const transportKey = (draftId: string) => `transport ${draftId}`;

  async function runTransport(draftId: string, t: Transport): Promise<PlaybackView> {
    if (t.play)
      return remember(
        draftId,
        await player.play(draftId, revision(draftId), t.play.entryId, t.play.position),
      );

    const last = seen.get(draftId);

    // A play and pause that met while waiting leave nothing to stop unless this draft was playing.
    if (t.run === 'pause' && !(last?.entry_id !== undefined && last.state === 'playing'))
      t = { ...t, run: undefined };

    let view: PlaybackView | undefined;

    if (t.run === 'pause') view = await player.control(draftId, { action: 'pause' });

    if (t.seek !== undefined)
      view = await player.control(draftId, { action: 'seek', position: t.seek });

    if (t.run === 'resume') view = await player.control(draftId, { action: 'resume' });

    return remember(draftId, view ?? (await player.state(draftId)));
  }

  // The newest call decides: a play replaces what waits, a seek moves it, a pause and resume cancel.
  function merge(t: Transport, next: Transport) {
    if (next.play) {
      t.play = next.play;
      t.seek = undefined;
      t.run = undefined;
    } else if (next.seek !== undefined) {
      if (t.play) t.play.position = next.seek;
      else t.seek = next.seek;
    } else if (next.run === 'pause') {
      t.play = undefined;
      t.run = t.run === 'resume' ? undefined : 'pause';
    } else if (next.run === 'resume' && !t.play) {
      t.run = t.run === 'pause' ? undefined : 'resume';
    }
  }

  function transport(draftId: string, next: Transport): Promise<PlaybackView> {
    const key = transportKey(draftId);
    const last = queue.at(-1);

    // Only the job at the back merges, so nothing queued after a call ever runs before it.
    if (last?.key === key && last.transport) {
      merge(last.transport, next);

      return join(last);
    }

    const t: Transport = {};

    merge(t, next);

    return push({
      key,
      transport: t,
      step: () =>
        t.play
          ? `play ${t.play.entryId}${t.play.position === undefined ? '' : ` at ${t.play.position}`}`
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
    const last = queue.at(-1);
    const args = { trackIds, index, position };

    // The waiting job's run reads these when it starts, so the newest replaces them in place.
    if (last?.key === 'audition' && last.audition) {
      Object.assign(last.audition, args);

      return join<AuditionView>(last);
    }

    const job = {
      key: 'audition',
      audition: args,
      step: () => `audition ${job.audition.index}`,
      run: async () => {
        const { trackIds: ids, index: at, position: from } = job.audition;

        return (heard = await player.audition(ids, at, from));
      },
    };

    return push<AuditionView>(job);
  }

  return {
    /** Answered from the last call while the lane works, so a poll never waits behind a play. */
    state(draftId: string): Promise<PlaybackView> {
      const last = seen.get(draftId);

      if (busy() && last) return Promise.resolve(last);

      return push({ run: async () => remember(draftId, await player.state(draftId)) });
    },

    play: (draftId: string, entryId: string, position?: number) =>
      transport(draftId, { play: { entryId, ...(position !== undefined && { position }) } }),
    pause: (draftId: string) => transport(draftId, { run: 'pause' }),
    resume: (draftId: string) => transport(draftId, { run: 'resume' }),
    seek: (draftId: string, position: number) => transport(draftId, { seek: position }),

    // Stopping makes whatever this draft still waits to play moot.
    detach(draftId: string, revisionAt: number) {
      drop((job) => job.key === transportKey(draftId));

      return push<void>({
        step: () => 'detach',
        run: async () => {
          seen.delete(draftId);
          await player.detach(draftId, revisionAt);
        },
      });
    },

    // Behind everything already asked, so an edit's order reaches Music before a play after it.
    sync(draftId: string) {
      const key = `sync ${draftId}`;
      const waiting = queue.find((job) => job.key === key);

      // The waiting sync reads the draft when it runs, so it covers this edit too.
      if (waiting) return join(waiting);

      return push({ key, step: () => 'sync preview', run: () => syncLinked(draftId) });
    },

    syncing: (draftId: string) =>
      running?.key === `sync ${draftId}` || queue.some((job) => job.key === `sync ${draftId}`),

    audition,

    auditionState(): Promise<AuditionView> {
      if (busy() && heard) return Promise.resolve(heard);

      return push({ run: async () => (heard = await player.auditionState()) });
    },

    auditionStop() {
      drop((job) => job.key === 'audition', { state: 'stopped' });

      return push<void>({
        step: () => 'stop audition',
        run: async () => {
          await player.stopAudition();
          heard = { state: 'stopped' };
        },
      });
    },

    /** Runs `step` in turn, for anything else that may write Music or depend on what it plays. */
    after: <T>(name: string, step: () => Promise<T> | T) =>
      push<T>({ step: () => name, run: async () => step() }),
  };
}
