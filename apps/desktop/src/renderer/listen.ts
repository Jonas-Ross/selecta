// Pure logic for the Listen screen: which record is playing, where the set is
// in time, and the key wheel's geometry. Music.app is the clock; this only
// reads it and fills in between reads.
import { parseCamelot } from '@selecta/core/domain/harmonic.js';
import type { PlayerView } from '../shared/protocol.js';
import type { EditQueue } from './edits.js';
import type { Row } from './state.js';

// AutoMix needs about this much of the outgoing track left to blend into the next.
export const JOIN_LEAD = 60;

/** Where "Hear the join" starts the outgoing track. */
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

    if (at !== undefined && allowed()) return play(at);
  });
}

/** A player action running, or a linked edit still syncing under the music lock, holds the transport. */
export function transportHeld(busy: boolean, linked: boolean, pending: unknown): boolean {
  return busy || (linked && pending !== undefined);
}

/**
 * Where "Hear the join" starts; with no known length there is no end to count back from.
 * Music.app reports an unset length as 0, so that counts as unknown too.
 */
export function joinStart(duration?: number): number | undefined {
  return duration === undefined || duration <= 0 ? undefined : Math.max(0, duration - JOIN_LEAD);
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

// Wheel radii per ring, minor A inside major B: the cell's band, the route's
// points, and the labels, kept apart so a dot never sits on its number.
const RINGS = {
  A: { cell: [52, 92], at: 64, label: 82 },
  B: { cell: [94, 134], at: 106, label: 124 },
} as const;

const f1 = (value: number) => value.toFixed(1);

function polar(radius: number, angle: number): [number, number] {
  return [radius * Math.sin(angle), -radius * Math.cos(angle)];
}

/** A Camelot position on the wheel, 12 at the top like a clock; undefined when unreadable. */
export function wheelPoint(
  camelot?: string,
  at: 'at' | 'label' = 'at',
): [number, number] | undefined {
  const position = parseCamelot(camelot);

  if (!position) return undefined;

  return polar(RINGS[position.mode][at], ((position.number % 12) * Math.PI) / 6);
}

/** The ring cell for one position, as an SVG path. */
export function wheelCell(number: number, mode: 'A' | 'B'): string {
  const [r0, r1] = RINGS[mode].cell;
  const a0 = ((number % 12) - 0.5) * (Math.PI / 6);
  const a1 = ((number % 12) + 0.5) * (Math.PI / 6);
  const p = (r: number, a: number) => polar(r, a).map(f1).join(' ');

  return `M${p(r0, a0)}L${p(r1, a0)}A${r1} ${r1} 0 0 1 ${p(r1, a1)}L${p(r0, a1)}A${r0} ${r0} 0 0 0 ${p(r0, a0)}Z`;
}

/** The set's route through the wheel from record `from` to `to`, lifting the pen at a missing key. */
export function wheelRoute(camelots: (string | undefined)[], from: number, to: number): string {
  let path = '';
  let pen = false;

  for (let i = Math.max(0, from); i <= Math.min(to, camelots.length - 1); i++) {
    const point = wheelPoint(camelots[i]);

    if (!point) {
      pen = false;
      continue;
    }

    path += `${pen ? 'L' : 'M'}${f1(point[0])} ${f1(point[1])}`;
    pen = true;
  }

  return path;
}
