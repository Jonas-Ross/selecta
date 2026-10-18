// Refreshing the library from the app: the same reread the MCP tool and the CLI
// run, then a measurement of tracks metrognome hasn't heard yet, newest first,
// through the queue the Measure buttons share.
import type { SelectaCache } from '@selecta/core/cache/index.js';
import { refreshLibrary } from '@selecta/core/operations/refresh.js';
import type { Bridge } from '@selecta/core/types/bridge.js';
import type { LibraryView, Measured } from '../shared/protocol.js';

// About six minutes at the store's search limit; a larger backlog is spread over later refreshes.
export const MEASURE_LIMIT = 100;
// Progress moves a run at a time, and a run this size settles in about half a minute.
const RUN_SIZE = 10;

export type LibraryDeps = {
  cache: () => SelectaCache;
  bridge: Bridge;
  measure: (trackId: string) => Promise<Measured>;
  onChange: (view: LibraryView) => void;
  /** Runs the read in turn with the app's other Music calls, which share its lock. */
  inTurn?: <T>(read: () => Promise<T>) => Promise<T>;
  now?: () => number;
};

export function createLibrary({
  cache,
  bridge,
  measure,
  onChange,
  inTurn = (read) => read(),
  now = Date.now,
}: LibraryDeps) {
  let view: LibraryView | undefined;

  const readAt = () => {
    const age = cache().getCacheAgeHours();

    return age == null ? null : Math.round(now() - age * 3_600_000);
  };

  const pending = () =>
    cache()
      .getTracksPendingEnrichment('analysis', Number.MAX_SAFE_INTEGER)
      .map((track) => track.persistentId);

  // Features metrognome supplied, so a track counts as measured only when this run landed one.
  const heardBy = (id: string) =>
    Object.values(cache().getAudioFeatures(id)?.sources ?? {}).filter((source) =>
      source?.startsWith('metrognome'),
    ).length;

  function set(next: LibraryView) {
    view = next;
    onChange(next);
  }

  async function measureNew(before: Set<string>): Promise<LibraryView> {
    const after = pending();
    const queue = [
      ...after.filter((id) => !before.has(id)),
      ...after.filter((id) => before.has(id)),
    ].slice(0, MEASURE_LIMIT);
    let measured = 0;

    for (let at = 0; at < queue.length; at += RUN_SIZE) {
      set({ read_at: readAt(), measuring: { done: at, of: queue.length } });

      const run = queue.slice(at, at + RUN_SIZE);
      const had = run.map(heardBy);
      const results = await Promise.all(run.map(measure));
      const failed = results.find((result) => result.error);

      // A run that failed outright (no metrognome, store down) would fail the same way again.
      if (failed && results.every((result) => result.error))
        return { read_at: readAt(), measured, failed: 'measure', error: failed.error };

      measured += run.filter((id, i) => heardBy(id) > had[i]!).length;
    }

    return { read_at: readAt(), measured, left: cache().countPendingEnrichment('analysis') };
  }

  async function run(): Promise<LibraryView> {
    const before = new Set(pending());

    try {
      await inTurn(() => refreshLibrary(cache(), bridge));
    } catch (error) {
      return { read_at: readAt(), failed: 'read', error: message(error) };
    }

    try {
      return await measureNew(before);
    } catch (error) {
      return { read_at: readAt(), failed: 'measure', error: message(error) };
    }
  }

  const state = (): LibraryView => (view ??= { read_at: readAt() });

  return {
    state,

    /** Start a refresh, or report the one already going. */
    refresh(): LibraryView {
      const current = state();

      if (current.reading || current.measuring) return current;

      set({ read_at: current.read_at, reading: true });
      void run().then(set);

      return view!;
    },
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
