// What each blank tempo or key can say about itself, shared by every place one
// shows, so the lane and the card agree: why it is blank where metrognome
// already listened, or how a measurement asked for in this session went.
import { useCallback, useSyncExternalStore } from 'react';
import { HEARD_LIMIT, type Measured, type SelectaApi } from '../../shared/protocol.js';
import { selecta } from '../api.js';

export type MeasureState =
  | { phase: 'measuring' }
  | { phase: 'done'; result: Measured }
  // Already settled before this session; no reason for a feature means measuring could help.
  | { phase: 'heard'; result: Measured };

export function createMeasureStore(call: SelectaApi['call']) {
  const states = new Map<string, MeasureState>();
  const listeners = new Map<string, Set<() => void>>();
  const landed = new Set<(trackId: string) => void>();
  const asked = new Set<string>();
  let batch: string[] = [];

  function set(trackId: string, state: MeasureState) {
    states.set(trackId, state);

    for (const listener of listeners.get(trackId) ?? []) listener();
  }

  function flush() {
    const ids = batch;

    batch = [];

    for (let start = 0; start < ids.length; start += HEARD_LIMIT) {
      const chunk = ids.slice(start, start + HEARD_LIMIT);

      // A failed lookup leaves the measure button, which is still right to offer.
      void call('features.heard', { track_ids: chunk }).then(
        (answers) => {
          for (const id of chunk) {
            const result = answers[id];

            if (result && !states.has(id)) set(id, { phase: 'heard', result });
          }
        },
        () => undefined,
      );
    }
  }

  return {
    subscribe(trackId: string, listener: () => void): () => void {
      let set = listeners.get(trackId);

      if (!set) listeners.set(trackId, (set = new Set()));

      set.add(listener);

      if (!asked.has(trackId)) {
        asked.add(trackId);

        if (batch.push(trackId) === 1) queueMicrotask(flush);
      }

      return () => {
        set.delete(listener);

        if (set.size === 0) listeners.delete(trackId);
      };
    },
    state: (trackId: string) => states.get(trackId),
    measure(trackId: string): void {
      if (states.get(trackId)?.phase === 'measuring') return;

      set(trackId, { phase: 'measuring' });
      void call('features.measure', { track_id: trackId }).then(
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
    },
    onMeasured(listener: (trackId: string) => void): () => void {
      landed.add(listener);

      return () => landed.delete(listener);
    },
  };
}

const store = createMeasureStore((...args) => selecta.call(...args));

export const measureTrack = (trackId: string) => store.measure(trackId);

/** Calls back once a measurement has stored what it found, so a view re-reads the track. */
export const onMeasured = (listener: (trackId: string) => void) => store.onMeasured(listener);

export function useMeasure(trackId: string): MeasureState | undefined {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(trackId, listener),
    [trackId],
  );

  return useSyncExternalStore(subscribe, () => store.state(trackId));
}
