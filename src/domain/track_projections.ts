// Explicit wire projections shared by tool handlers. No runtime storage dependencies.
import type { NoteRow, TrackRow } from '../types/cache.js';

// The model's own note on a track or playlist (issue #32), verbatim, with
// when it was first written and last changed. Same shape on every surface.
export type ApiNote = {
  body: string;
  created_at: string;
  updated_at: string;
};

// Notes are bounded at the zod boundary so a runaway body can't bloat every
// later read; the model structures the body however it likes within that.
export const NOTE_MAX_LENGTH = 2000;

/** The wire note from any row carrying note columns; undefined when unset. */
export function toApiNote(row: {
  noteBody: string | null;
  noteCreatedAt: string | null;
  noteUpdatedAt: string | null;
}): ApiNote | undefined {
  if (row.noteBody == null) return undefined;

  return { body: row.noteBody, created_at: row.noteCreatedAt!, updated_at: row.noteUpdatedAt! };
}

/** The wire note from a stored notes row (write responses); undefined when there is none. */
export function apiNoteFromRow(note: NoteRow): ApiNote;
export function apiNoteFromRow(note: NoteRow | null): ApiNote | undefined;

export function apiNoteFromRow(note: NoteRow | null): ApiNote | undefined {
  if (note === null) return undefined;

  return { body: note.body, created_at: note.createdAt, updated_at: note.updatedAt };
}

// The model-facing track shape: identity fields plus the behavioral signal
// bundle. Ratings are 0–5 stars here (Music.app's 0–100 internally). Absent
// fields are omitted entirely — undefined keys disappear in JSON, and over a
// 50-track response the saved tokens add up.
export type ApiTrack = {
  persistent_id: string;
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  genre?: string;
  duration_seconds?: number;
  location_kind?: string;
  // Enriched audio features (#19). Absent = not enriched yet, or no source had
  // data. bpm prefers the enriched value, falling back to the native tag.
  bpm?: number;
  musical_key?: string; // e.g. "F# minor"
  danceability?: number; // 0..1
  // The model's own earlier note on this track, verbatim. Memory, not signal:
  // Selecta never filters or orders on it.
  note?: ApiNote;
  signal: {
    play_count: number;
    skip_count: number;
    rating?: number; // 0..5 stars
    loved?: true;
    disliked?: true;
    last_played?: string;
    date_added?: string;
  };
};

// One fixed field order removes repeated object keys from broad results while
// retaining every comparison fact. Keep it explicit so compact output cannot
// silently grow when ApiTrack gains another field.
export const COMPACT_TRACK_FIELDS = [
  'persistent_id',
  'title',
  'artist',
  'album',
  'year',
  'genre',
  'duration_seconds',
  'bpm',
  'musical_key',
  'danceability',
  'signal.play_count',
  'signal.skip_count',
  'signal.rating',
  'signal.loved',
  'signal.disliked',
  'signal.last_played',
  'signal.date_added',
  'note',
] as const;

// Fixed row aligned with COMPACT_TRACK_FIELDS. Null marks an unavailable
// optional fact; location_kind is the only full-track field not represented.
export type CompactApiTrack = [
  persistentId: string,
  title: string | null,
  artist: string | null,
  album: string | null,
  year: number | null,
  genre: string | null,
  durationSeconds: number | null,
  bpm: number | null,
  musicalKey: string | null,
  danceability: number | null,
  playCount: number,
  skipCount: number,
  rating: number | null,
  loved: true | null,
  disliked: true | null,
  lastPlayed: string | null,
  dateAdded: string | null,
  note: ApiNote | null,
];

export function toApiTrack(row: TrackRow): ApiTrack {
  return {
    persistent_id: row.persistentId,
    title: row.title ?? undefined,
    artist: row.artist ?? undefined,
    album: row.album ?? undefined,
    year: row.year ?? undefined,
    genre: row.genre ?? undefined,
    duration_seconds: row.durationSeconds ?? undefined,
    location_kind: row.locationKind ?? undefined,
    // Analyzer output carries noise decimals; one decimal of tempo (two of
    // danceability) is all the precision that survives the wire.
    bpm: row.bpm != null ? Math.round(row.bpm * 10) / 10 : undefined,
    musical_key: row.musicalKey ?? undefined,
    danceability: row.danceability != null ? Math.round(row.danceability * 100) / 100 : undefined,
    note: toApiNote(row),
    signal: {
      play_count: row.playCount,
      skip_count: row.skipCount,
      rating: row.rating != null ? row.rating / 20 : undefined,
      loved: row.loved === 1 ? true : undefined,
      disliked: row.disliked === 1 ? true : undefined,
      last_played: row.lastPlayed ?? undefined,
      date_added: row.dateAdded ?? undefined,
    },
  };
}

/** Reduce a full API track to the stable compact discovery contract. */
export function toCompactApiTrack(track: ApiTrack): CompactApiTrack {
  return [
    track.persistent_id,
    track.title ?? null,
    track.artist ?? null,
    track.album ?? null,
    track.year ?? null,
    track.genre ?? null,
    track.duration_seconds ?? null,
    track.bpm ?? null,
    track.musical_key ?? null,
    track.danceability ?? null,
    track.signal.play_count,
    track.signal.skip_count,
    track.signal.rating ?? null,
    track.signal.loved ?? null,
    track.signal.disliked ?? null,
    track.signal.last_played ?? null,
    track.signal.date_added ?? null,
    track.note ?? null,
  ];
}

/** Map one cache row through the requested full or compact wire projection. */
export function projectApiTrack(row: TrackRow, compact: true): CompactApiTrack;
export function projectApiTrack(row: TrackRow, compact: false): ApiTrack;
export function projectApiTrack(row: TrackRow, compact: boolean): ApiTrack | CompactApiTrack;

export function projectApiTrack(row: TrackRow, compact: boolean): ApiTrack | CompactApiTrack {
  const track = toApiTrack(row);

  return compact ? toCompactApiTrack(track) : track;
}

export type InspectedTrack = Pick<
  ApiTrack,
  | 'persistent_id'
  | 'title'
  | 'artist'
  | 'album'
  | 'duration_seconds'
  | 'bpm'
  | 'musical_key'
  | 'danceability'
  | 'note'
> & {
  signal: Pick<ApiTrack['signal'], 'play_count' | 'skip_count' | 'rating' | 'loved'>;
};

/** Fixed inspection view; full-track additions never leak into this reduced contract. */
export function toInspectedTrack(track: ApiTrack): InspectedTrack {
  return {
    persistent_id: track.persistent_id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration_seconds: track.duration_seconds,
    bpm: track.bpm,
    musical_key: track.musical_key,
    danceability: track.danceability,
    note: track.note,
    signal: {
      play_count: track.signal.play_count,
      skip_count: track.signal.skip_count,
      rating: track.signal.rating,
      loved: track.signal.loved,
    },
  };
}
