// Wire projections for tool handlers.
import type { FeatureMaturity, NoteRow, TrackRow } from '../types/cache.js';

export type ApiNote = {
  body: string;
  created_at: string;
  updated_at: string;
};

// Bounded at zod boundary so runaway bodies can't bloat reads.
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

// Ratings: 0–5 here (Music.app uses 0–100). Absent fields omit the keys.
export type ApiTrack = {
  persistent_id: string;
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  genre?: string;
  duration_seconds?: number;
  location_kind?: string;
  bpm?: number; // enriched or fallback to tag
  musical_key?: string; // e.g. "F# minor"
  camelot?: string; // the same key on the DJ wheel, e.g. "11A"
  danceability?: number; // 0..1
  note?: ApiNote; // model's own annotation
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

// Fixed order so compact output keys don't repeat; sync this with ApiTrack.
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
  'camelot',
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

// Tuple aligned with COMPACT_TRACK_FIELDS. Null = unavailable.
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
  camelot: string | null,
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

// Two decimals is all that survives of an analyzer's 0-1 scores on the wire.
const round2 = (value: number | null): number | undefined =>
  value == null ? undefined : Math.round(value * 100) / 100;

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
    // Analyzer output carries noise decimals; one decimal of tempo is all the
    // precision that survives the wire.
    bpm: row.bpm != null ? Math.round(row.bpm * 10) / 10 : undefined,
    musical_key: row.musicalKey ?? undefined,
    camelot: row.camelot ?? undefined,
    danceability: round2(row.danceability),
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
    track.camelot ?? null,
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
  | 'camelot'
  | 'danceability'
  | 'note'
> & {
  // How far to trust the two estimated features, omitted when unknown. Only
  // this view carries them: a settled tracklist is small and is being
  // scrutinized, where discovery results are long and are being scanned.
  bpm_confidence?: number; // 0..1, for this measurement
  bpm_maturity?: FeatureMaturity; // how far the estimator itself is validated
  key_confidence?: number;
  key_maturity?: FeatureMaturity;
  signal: Pick<ApiTrack['signal'], 'play_count' | 'skip_count' | 'rating' | 'loved'>;
};

/** Fixed inspection view; full-track additions never leak into this reduced contract. */
export function toInspectedTrack(row: TrackRow): InspectedTrack {
  const track = toApiTrack(row);

  return {
    persistent_id: track.persistent_id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration_seconds: track.duration_seconds,
    bpm: track.bpm,
    musical_key: track.musical_key,
    camelot: track.camelot,
    danceability: track.danceability,
    bpm_confidence: round2(row.bpmConfidence),
    bpm_maturity: row.bpmMaturity ?? undefined,
    key_confidence: round2(row.keyConfidence),
    key_maturity: row.keyMaturity ?? undefined,
    note: track.note,
    signal: {
      play_count: track.signal.play_count,
      skip_count: track.signal.skip_count,
      rating: track.signal.rating,
      loved: track.signal.loved,
    },
  };
}
