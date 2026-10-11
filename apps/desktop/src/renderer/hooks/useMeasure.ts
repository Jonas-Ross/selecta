// Measurements asked for in this session, shared by every place a blank
// tempo or key shows, so the lane and the card agree on what is happening.
import { useSyncExternalStore } from 'react';
import type { Measured } from '../../shared/protocol.js';
import { selecta } from '../api.js';

export type MeasureState = { phase: 'measuring' } | { phase: 'done'; result: Measured };

const states = new Map<string, MeasureState>();
const watchers = new Set<() => void>();
const landed = new Set<(trackId: string) => void>();

function set(trackId: string, state: MeasureState) {
  states.set(trackId, state);

  for (const watcher of watchers) watcher();
}

export function measureTrack(trackId: string): void {
  if (states.get(trackId)?.phase === 'measuring') return;

  set(trackId, { phase: 'measuring' });
  void selecta.call('features.measure', { track_id: trackId }).then(
    (result) => {
      set(trackId, { phase: 'done', result });

      for (const listener of landed) listener(trackId);
    },
    (e: Error) =>
      set(trackId, {
        phase: 'done',
        result: { tempo: 'failed', key: 'failed', error: e.message },
      }),
  );
}

/** Calls back once a measurement has stored what it found, so a view re-reads the track. */
export function onMeasured(listener: (trackId: string) => void): () => void {
  landed.add(listener);

  return () => landed.delete(listener);
}

export function useMeasure(trackId: string): MeasureState | undefined {
  return useSyncExternalStore(
    (watch) => {
      watchers.add(watch);

      return () => watchers.delete(watch);
    },
    () => states.get(trackId),
  );
}
