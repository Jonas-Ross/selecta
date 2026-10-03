// Album art URLs for the records on screen. Sleeves that mount together ask in
// one call, and every answer, no art included, holds for the session. A failed
// lookup is reported and stays failed until the user asks to try again.
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
  // Why each failed lookup failed, kept so a notice opened later still hears it.
  const failed = new Map<string, string>();
  const reloaded = new Set<string>();
  let batch: string[] = [];

  function settle(id: string, file: string | null) {
    answers.set(id, file === null ? null : artworkUrl(file));

    for (const listener of listeners.get(id) ?? []) listener();
  }

  function fail(id: string, message: string) {
    failed.set(id, message);
    failures.forEach((listener) => listener(message));
  }

  function flush() {
    const ids = batch;

    batch = [];

    for (let start = 0; start < ids.length; start += ARTWORK_GET_LIMIT) {
      const chunk = ids.slice(start, start + ARTWORK_GET_LIMIT);

      get({ track_ids: chunk }).then(
        (files) =>
          chunk.forEach((id) => {
            const file = files[id] ?? null;

            if (typeof file === 'object' && file !== null) fail(id, file.error);
            else settle(id, file);
          }),
        (error: Error) => chunk.forEach((id) => fail(id, error.message)),
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
    /** The art at the URL given couldn't be shown: ask once more, then call it a failure. */
    broken(id: string) {
      // Every copy of a sleeve reports the same broken image; the first one acts.
      if (!answers.get(id)) return;

      answers.delete(id);

      if (reloaded.has(id)) {
        fail(id, `the album art file for ${id} can't be shown`);
      } else {
        reloaded.add(id);
        asked.delete(id);
        request(id);
      }

      for (const listener of listeners.get(id) ?? []) listener();
    },
    /** Asks again for every failed lookup still on screen; the rest ask when they next appear. */
    retry() {
      for (const id of failed.keys()) {
        failed.delete(id);
        asked.delete(id);

        if (listeners.has(id)) request(id);
      }
    },
    /** Hears every failure from now on, and at once the latest still standing. */
    onFailure(listener: (message: string) => void): () => void {
      failures.add(listener);

      const standing = [...failed.values()].at(-1);

      if (standing !== undefined) listener(standing);

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

export const retryArtwork = () => store.retry();

export const artworkBroken = (trackId: string) => store.broken(trackId);
