// Measuring one track on request: metrognome over that track's store preview,
// through the same analysis pass `enrich --source analysis` runs. Requests
// share one queue so a run of clicks never outpaces the iTunes rate limit.
import type { AudioFeaturesRow } from '@selecta/core/types/cache.js';
import type { Measured, MissReason } from '../shared/protocol.js';

/** One metrognome run over these tracks; resolves once their results are stored. */
export type MeasureRun = (trackIds: string[]) => Promise<{ skipped: string[]; errors: string[] }>;

export type MeasurerDeps = {
  run: MeasureRun;
  features: (trackId: string) => AudioFeaturesRow | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

// metrognome's own limiter allows 18 store searches a minute, but each process
// starts with a fresh burst, so the host paces the runs it starts as well.
export const SEARCH_SPACING_MS = 60_000 / 18;

export function createMeasurer({
  run,
  features,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: MeasurerDeps) {
  type Waiter = { resolve: (value: Measured) => void; reject: (error: Error) => void };
  const queued = new Map<string, Waiter>();
  const inFlight = new Map<string, Promise<Measured>>();
  let working = false;
  let nextStart = 0;

  async function drain(): Promise<void> {
    working = true;

    while (queued.size > 0) {
      await sleep(Math.max(0, nextStart - now()));

      const batch = [...queued];

      queued.clear();
      nextStart = now() + batch.length * SEARCH_SPACING_MS;

      try {
        const { skipped, errors } = await run(batch.map(([id]) => id));

        for (const [id, waiter] of batch)
          waiter.resolve(verdict(features(id), skipped.includes(id) ? errors[0] : undefined));
      } catch (error) {
        for (const [, waiter] of batch) waiter.reject(error as Error);
      }
    }

    working = false;
  }

  return {
    /** Measure a track, or join the measurement of it already waiting or running. */
    measure(trackId: string): Promise<Measured> {
      const existing = inFlight.get(trackId);

      if (existing) return existing;

      const promise = new Promise<Measured>((resolve, reject) => {
        queued.set(trackId, { resolve, reject });
      }).finally(() => inFlight.delete(trackId));

      inFlight.set(trackId, promise);

      if (!working) void drain();

      return promise;
    },
  };
}

/**
 * Why each feature is still blank after a run, or nothing where it has a
 * value. `failure` is the run's reason when it left this track unsettled.
 */
export function verdict(row: AudioFeaturesRow | undefined, failure?: string): Measured {
  const why = ((): MissReason => {
    if (failure !== undefined) return 'failed';

    switch (row?.analysisStatus) {
      // It listened and kept the other feature, so this one was too unsure to store.
      case 'ok':
        return 'unsure';
      case 'no_data':
        return 'no_reading';
      case 'no_match':
        return 'not_found';
      default:
        return 'failed';
    }
  })();

  return {
    ...(row?.bpm == null && { tempo: why }),
    ...(row?.musicalKey == null && { key: why }),
    ...(failure !== undefined && { error: failure }),
  };
}
