// Pure logic for the Listen screen: which record is playing, where the set is
// in time. Music.app is the clock; this only reads it and fills in between reads.
import type { PlayerView } from '../shared/protocol.js';
import type { EditQueue } from './edits.js';
import type { Row } from './state.js';

/**
 * Plays once the edits queued ahead have landed, on the revision they left, unless
 * `allowed` turned false meanwhile: Claude starting then would have its edits refused.
 */
export function queuePlay(
  queue: Pick<EditQueue<unknown>, 'after'>,
  allowed: () => boolean,
  revision: () => number | undefined,
  play: (revision: number) => unknown,
): Promise<unknown> {
  return queue.after(() => {
    const at = revision();

    return at !== undefined && allowed() ? play(at) : undefined;
  });
}

/** A player action running, or a linked edit still syncing under the music lock, holds the transport. */
export function transportHeld(busy: boolean, linked: boolean, pending: unknown): boolean {
  return busy || (linked && pending !== undefined);
}

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
  const moved = player?.state === 'playing' ? Math.max(0, (now - readAt) / 1000) : 0;

  // Music.app reports an unset length as 0, which is no bound.
  return Math.min(player?.duration || Infinity, at + moved);
}

export type Press =
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'seek'; position: number };

/**
 * What the player shows from the moment a press lands until Music.app answers, which
 * replaces it either way. Only a draft's own record can be pressed, so a view off it is kept.
 */
export function pressed(player: PlayerView, readAt: number, now: number, press: Press): PlayerView {
  if (player.entry_id === undefined || player.state === 'stopped') return player;

  const position = livePosition(player, readAt, now);

  if (press.action === 'pause') return { ...player, state: 'paused', position };

  if (press.action === 'resume') return { ...player, state: 'playing', position };

  return { ...player, position: Math.min(player.duration || Infinity, press.position) };
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
