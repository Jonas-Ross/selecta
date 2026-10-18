// Pure logic for the Listen screen: which record is playing, where the set is
// in time. Music.app is the clock; this only reads it and fills in between reads.
import type { PlayerView } from '../shared/protocol.js';
import type { EditQueue } from './edits.js';
import type { Row } from './state.js';

/**
 * Sends `call` once the edits queued ahead have landed, so Music gets the order they left, unless
 * `allowed` turned false meanwhile: Claude starting then would have its edits refused. Edits
 * behind it don't wait for Music's answer, and nor do later calls, which the host folds together.
 */
export function afterEdits<T>(
  queue: Pick<EditQueue<unknown>, 'after'>,
  allowed: () => boolean,
  call: () => Promise<T>,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    void queue.after(() => {
      if (allowed()) call().then(resolve, reject);
      else resolve(undefined);
    });
  });
}

/** What each transport action asks Music for, drawn on the screen until the host answers. */
export const asked = {
  play: (entryId: string, position?: number): PlayerView => ({
    running: true,
    state: 'playing',
    entry_id: entryId,
    position: position ?? 0,
  }),
  pause: (view: PlayerView | undefined, readAt: number, now: number): PlayerView | undefined =>
    view && { ...view, state: 'paused', position: livePosition(view, readAt, now) },
  resume: (view: PlayerView | undefined): PlayerView | undefined =>
    view && { ...view, state: 'playing' },
  seek: (view: PlayerView | undefined, position: number): PlayerView | undefined =>
    view && { ...view, position },
  // Stopping pauses Music only if it's on this draft.
  stop: (view: PlayerView | undefined): PlayerView | undefined =>
    view?.entry_id !== undefined && view.state === 'playing' ? { ...view, state: 'paused' } : view,
};

/**
 * Where "Hear the transition" starts; with no known length there is no end to count back from.
 * Music.app reports an unset length as 0, so that counts as unknown too.
 */
export function joinStart(duration: number | undefined, lead: number): number | undefined {
  return duration === undefined || duration <= 0 ? undefined : Math.max(0, duration - lead);
}

/** The record the Listen screen centres on: what plays if it's in this draft, else the cued one. */
export function nowIndex(items: Row[], player: PlayerView | undefined, cued?: string): number {
  const playing = player?.entry_id && items.findIndex((row) => row.entry_id === player.entry_id);

  if (typeof playing === 'number' && playing >= 0) return playing;

  const at = cued === undefined ? -1 : items.findIndex((row) => row.entry_id === cued);

  return at >= 0 ? at : 0;
}

/** Music.app is read about once a second; a playing position moves on between reads. */
export function livePosition(player: PlayerView | undefined, readAt: number, now: number): number {
  const at = player?.position ?? 0;
  // A play Music hasn't confirmed holds still rather than run ahead of where Music starts.
  const moved =
    player?.state === 'playing' && !player.pending ? Math.max(0, (now - readAt) / 1000) : 0;

  // Music.app reports an unset length as 0, which is no bound.
  return Math.min(player?.duration || Infinity, at + moved);
}

/** Seconds into the whole set, and whether an unknown length makes that a lower bound. */
export function setClock(items: Row[], index: number, position: number) {
  const before = items.slice(0, index);

  return {
    elapsed: before.reduce((sum, row) => sum + (row.duration_seconds ?? 0), 0) + position,
    partial: before.some((row) => row.duration_seconds === undefined),
  };
}

/** Why the player isn't showing this draft, in words, or undefined when it is. */
export function elsewhere(player: PlayerView | undefined): string | undefined {
  if (!player) return undefined;

  if (!player.running) return 'Music is closed';

  if (player.entry_id !== undefined || player.state === 'stopped') return undefined;

  return 'Music is playing something outside this draft';
}
