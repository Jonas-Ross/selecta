// Album art URLs for the records on screen. Sleeves that mount together ask in
// one call, and every answer, no art included, holds for the session; a failed
// lookup is reported and asked again when the sleeve next mounts.
import { useCallback, useSyncExternalStore } from 'react';
import { ARTWORK_GET_LIMIT, artworkUrl } from '../shared/artwork.js';
import type { Methods } from '../shared/protocol.js';
import { selecta } from './api.js';

type Get = (args: { track_ids: string[] }) => Promise<ReturnType<Methods['artwork.get']>>;

export function createArtworkStore(get: Get) {
  // null: asked and Music.app has none.
  const answers = new Map<string, string | null>();
  const listeners = new Map<string, Set<() => void>>();
  const failures = new Set<(message: string) => void>();
  const asked = new Set<string>();
  let batch: string[] = [];

  function settle(id: string, file: string | null) {
    answers.set(id, file === null ? null : artworkUrl(file));

    for (const listener of listeners.get(id) ?? []) listener();
  }

  function flush() {
    const ids = batch;

    batch = [];

    for (let start = 0; start < ids.length; start += ARTWORK_GET_LIMIT) {
      const chunk = ids.slice(start, start + ARTWORK_GET_LIMIT);

      get({ track_ids: chunk }).then(
        (files) => chunk.forEach((id) => settle(id, files[id] ?? null)),
        (error: Error) => {
          chunk.forEach((id) => asked.delete(id));
          failures.forEach((listener) => listener(error.message));
        },
      );
    }
  }

  function request(id: string) {
    if (asked.has(id)) return;

    asked.add(id);

    if (batch.push(id) === 1) queueMicrotask(flush);
  }

  return {
    subscribe(id: string, listener: () => void): () => void {
      let set = listeners.get(id);

      if (!set) listeners.set(id, (set = new Set()));

      set.add(listener);
      request(id);

      return () => {
        set.delete(listener);

        if (set.size === 0) listeners.delete(id);
      };
    },
    onFailure(listener: (message: string) => void): () => void {
      failures.add(listener);

      return () => failures.delete(listener);
    },
    /** The art's URL once known; undefined while asking or when there is none. */
    url(id: string): string | undefined {
      return answers.get(id) ?? undefined;
    },
  };
}

const store = createArtworkStore((args) => selecta.call('artwork.get', args));

export function useArtwork(trackId: string): string | undefined {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(trackId, listener),
    [trackId],
  );

  return useSyncExternalStore(subscribe, () => store.url(trackId));
}

/** Calls `listener` with the reason whenever an artwork lookup fails. */
export const onArtworkFailure = (listener: (message: string) => void) => store.onFailure(listener);
