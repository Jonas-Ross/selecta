// Pure logic for replacing one record: who stands either side of it, what an
// audition plays, and the edit a swap makes.
import type { Suggestion } from '../shared/protocol.js';
import { joinStart } from './listen.js';
import type { Row, Track } from './state.js';

// Past the intro, where most tracks have settled into what they are.
const HEAR_AT = 1 / 3;

export type Around = { at: number; prev?: Row; row: Row; next?: Row };

/** The record being replaced and its neighbours, or undefined once it has left the draft. */
export function around(items: Row[], entryId: string): Around | undefined {
  const at = items.findIndex((row) => row.entry_id === entryId);
  const row = items[at];

  return row && { at, prev: items[at - 1], row, next: items[at + 1] };
}

/** A pick as a track the joins can read. */
export const pickTrack = ({ track }: Suggestion): Track & { track_id: string } => ({
  ...track,
  track_id: track.persistent_id,
});

export type Listening = 'hear' | 'in' | 'out';

export type AuditionPlan = { track_ids: string[]; index: number; position?: number };

/**
 * Selecta Preview gets the neighbours either side of the candidate, so Music plays on
 * through the join and AutoMix blends it. Undefined when there is no such join to hear.
 */
export function auditionPlan(
  { prev, next }: Pick<Around, 'prev' | 'next'>,
  candidate: { track_id: string; duration_seconds?: number },
  listening: Listening,
): AuditionPlan | undefined {
  const track_ids = [prev?.track_id, candidate.track_id, next?.track_id].filter(
    (id): id is string => id !== undefined,
  );
  const at = prev ? 1 : 0;
  const plan = (index: number, position?: number) => ({
    track_ids,
    index,
    ...(position !== undefined && { position }),
  });

  if (listening === 'hear')
    return plan(
      at,
      candidate.duration_seconds ? Math.round(candidate.duration_seconds * HEAR_AT) : undefined,
    );

  // With no known length there is no end to count back from, so no join to hear.
  const from = joinStart(listening === 'in' ? prev?.duration_seconds : candidate.duration_seconds);

  if (from === undefined) return undefined;

  if (listening === 'in') return prev && plan(0, from);

  return next && plan(at, from);
}

/** The draft with one entry's track swapped; the new track is a new entry. Undefined once it's gone. */
export function swapEntries(
  entries: { entry_id: string; track_id: string }[],
  entryId: string,
  trackId: string,
): { entry_id?: string; track_id: string }[] | undefined {
  if (!entries.some((entry) => entry.entry_id === entryId)) return undefined;

  return entries.map(({ entry_id, track_id }) =>
    entry_id === entryId ? { track_id: trackId } : { entry_id, track_id },
  );
}

/** The entry a swap added: the one holding the track that wasn't on the rail before it. */
export function swappedIn(
  entries: { entry_id: string; track_id: string }[],
  known: Set<string>,
  trackId: string,
): string | undefined {
  return entries.find((entry) => entry.track_id === trackId && !known.has(entry.entry_id))
    ?.entry_id;
}
