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

/** What the picks were chosen for: the record and the tracks either side of it. */
export const site = ({ prev, row, next }: Around) =>
  [prev?.track_id, row.track_id, next?.track_id].join(' ');

/** A pick as a track the joins can read. */
export const pickTrack = ({ track }: Suggestion): Track & { track_id: string } => ({
  ...track,
  track_id: track.persistent_id,
});

export type Listening = 'hear' | 'in' | 'out';

export type AuditionPlan = { track_ids: string[]; index: number; position?: number };

/**
 * Stops once the player call under way has landed, so a late start can't play on unheard and
 * a pause in flight isn't raced for Music's lock. Stopping again after a pause is a no-op.
 */
export const stopAfter = (inFlight: Promise<unknown> | undefined, stop: () => Promise<unknown>) =>
  (inFlight ?? Promise.resolve()).then(stop, stop);

/** Reads every `every` ms until stopped. A failed read is handed on and ends the poll, never retried. */
export function poll<T>(
  read: () => Promise<T>,
  every: number,
  heard: (next: T) => void,
  failed: (e: Error) => void,
): () => void {
  let alive = true;
  let timer: ReturnType<typeof setTimeout>;
  const later = () => {
    timer = setTimeout(() => {
      void read().then(
        (next) => {
          if (!alive) return;

          heard(next);
          later();
        },
        (e: Error) => alive && failed(e),
      );
    }, every);
  };

  later();

  return () => {
    alive = false;
    clearTimeout(timer);
  };
}

/**
 * Selecta Preview gets the neighbours either side of the candidate, so Music plays on
 * through the join and AutoMix blends it; a join starts `lead` seconds before it. Undefined when there is no such join to hear.
 */
export function auditionPlan(
  { prev, next }: Pick<Around, 'prev' | 'next'>,
  candidate: { track_id: string; duration_seconds?: number },
  listening: Listening,
  lead: number,
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
  const from = joinStart(
    listening === 'in' ? prev?.duration_seconds : candidate.duration_seconds,
    lead,
  );

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

/**
 * A swap as a draft change, and the entry it added once it lands: the one holding the track
 * that wasn't in the draft the change applied to, which may be newer than the rail.
 */
export function swapEdit(entryId: string, trackId: string) {
  let known: Set<string> | undefined;

  return {
    change(entries: { entry_id: string; track_id: string }[]) {
      known = new Set(entries.map((entry) => entry.entry_id));

      return swapEntries(entries, entryId, trackId);
    },
    added: (entries: { entry_id: string; track_id: string }[]) =>
      entries.find((entry) => entry.track_id === trackId && known && !known.has(entry.entry_id))
        ?.entry_id,
  };
}
