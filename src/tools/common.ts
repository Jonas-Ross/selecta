// Shared tool-handler plumbing: the deps bundle, the
// cache-row → API-track mapping, and error envelope conversion. Handlers are
// plain async functions returning output-or-SelectaError — the only layer that
// knows MCP exists is server.ts, and even it only wraps these.

import { z } from 'zod';
import type { Bridge } from '../types/bridge.js';
import type { PlaylistRow, SearchFilters, TrackRow } from '../types/cache.js';
import { BridgeError, defaultHints, type SelectaError } from '../types/errors.js';
import type { SelectaCache } from '../cache/index.js';
import type { EnrichDeps } from '../enrich/index.js';

// cache is a lazy getter so a broken cache (unwritable dir, corrupt file)
// surfaces per-call as a cache_unavailable envelope instead of crashing the
// server at startup — and cold start stays under the 200ms budget.
// enrich overrides the enrichment engine's fetch/clock/timer — tests inject
// canned sources here; production leaves it unset for the real network.
export type ToolDeps = {
  cache: () => SelectaCache;
  bridge: Bridge;
  enrich?: EnrichDeps;
};

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

export function validationError(hint: string): SelectaError {
  return { error: 'validation_error', hint };
}

/** Shared zod parse → validation_error envelope, one format for every tool. */
export function parseInput<T>(
  schema: z.ZodType<T>,
  raw: unknown,
): { ok: true; data: T } | { ok: false; error: SelectaError } {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: validationError(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Pre-flight for write tools: every referenced track must exist in the cache.
 * Returns a track_not_found envelope naming the offenders, or null when all
 * resolve. The bridge re-checks against the live library; this catches model
 * mistakes (hallucinated/typo'd IDs) before any Apple event fires.
 */
export function missingTrackIdsError(cache: SelectaCache, trackIds: string[]): SelectaError | null {
  const missing = trackIds.filter((id) => cache.getTrack(id) === null);
  if (missing.length === 0) return null;
  const shown = missing.slice(0, 5).join(', ');
  const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
  return {
    error: 'track_not_found',
    hint: `Not in the cache: ${shown}${more}. Use persistent IDs exactly as returned by search/get_track_context; if the library changed, run refresh_library.`,
  };
}

/**
 * Pre-flight for the playlist-edit tools: resolve the model-supplied playlist
 * ID (following creation receipts across iCloud rekeys) to a cached plain user
 * playlist. Smart/subscription/folder playlists are read-only in Music.app's
 * scripting interface. The bridge re-checks against the live library; this
 * catches stale/typo'd IDs before any Apple event fires.
 */
export function resolveEditablePlaylist(
  cache: SelectaCache,
  playlistId: string,
): { ok: true; playlist: PlaylistRow } | { ok: false; error: SelectaError } {
  const playlist = cache.getPlaylist(cache.resolvePlaylistId(playlistId));
  if (playlist === null) {
    return {
      ok: false,
      error: {
        error: 'playlist_not_found',
        hint: `No playlist ${playlistId} in the cache. Use IDs exactly as returned by list_playlists; if the library changed, run refresh_library.`,
      },
    };
  }
  if (playlist.kind !== 'user') {
    return {
      ok: false,
      error: {
        error: 'playlist_not_editable',
        hint: `"${playlist.name}" is a ${playlist.kind} playlist — only plain user playlists can be edited.`,
      },
    };
  }
  return { ok: true, playlist };
}

/** Convert a thrown BridgeError to the wire envelope; rethrow anything else. */
export function toErrorEnvelope(err: unknown): SelectaError {
  if (err instanceof BridgeError) {
    return { error: err.errorCode, hint: err.hint ?? defaultHints[err.errorCode] };
  }
  throw err;
}

export function isSelectaError(value: object): value is SelectaError {
  return 'error' in value;
}

/** Round cache age for the wire — sub-minute precision is token noise. */
export function roundedCacheAge(deps: ToolDeps): number | null {
  const age = deps.cache().getCacheAgeHours();
  return age == null ? null : Math.round(age * 100) / 100;
}

// ── Shared faceted filters (search + library_overview) ──────────────────────
// Both tools accept the same optional facets, ANDed. search adds `limit`;
// library_overview takes the bare shape. Defined once here so the two surfaces
// can't drift — and so adding a facet (e.g. bpm_min/bpm_max) is a one-line
// change both tools pick up.

// Anchor the date portion: bare YYYY-MM-DD or a full ISO timestamp (…T…), but
// not a date with a junk suffix like "2026-01-01nonsense".
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(?:$|T)/, 'expected an ISO date (YYYY-MM-DD…)');

export const libraryFilterShape = {
  query: z
    .string()
    .min(1)
    .optional()
    .describe('Free text over title/artist/album, relevance-ranked. Multi-word terms AND together.'),
  artist: z.string().optional().describe('Exact artist name, case-insensitive.'),
  genre: z.string().optional().describe('Exact genre name, case-insensitive.'),
  year_min: z.number().int().optional(),
  year_max: z.number().int().optional(),
  bpm_min: z
    .number()
    .positive()
    .optional()
    .describe('Minimum tempo (BPM). Only tracks with a known tempo can match.'),
  bpm_max: z.number().positive().optional(),
  loved: z.boolean().optional().describe('true → only favorited tracks; false → only non-favorited.'),
  disliked: z.boolean().optional(),
  rating_min: z.number().min(1).max(5).optional().describe('Minimum star rating, 1–5.'),
  min_plays: z.number().int().min(0).optional(),
  max_plays: z.number().int().min(0).optional(),
  last_played_before: isoDate
    .optional()
    .describe('ISO date. Includes never-played tracks (use to dig up forgotten music).'),
  last_played_after: isoDate.optional(),
  added_before: isoDate.optional(),
  added_after: isoDate.optional(),
  in_playlist: z.string().optional().describe('Playlist persistent ID (from list_playlists).'),
  location_kind: z.enum(['local', 'cloud']).optional().describe('local = playable offline.'),
  exclude_artists: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Artist names to drop from results, exact case-insensitive match. Tracks with no artist are kept.',
    ),
  exclude_tracks: z
    .array(z.string().min(1))
    .optional()
    .describe('Track persistent IDs to drop from results.'),
};

/** The bare filter object (no limit) — library_overview's full input schema. */
export const LibraryFilters = z.strictObject(libraryFilterShape);
export type LibraryFilterInput = z.infer<typeof LibraryFilters>;

/**
 * Map API filter input (snake_case, 1–5 stars) to the cache layer's
 * SearchFilters (camelCase, Music's 0–100 rating). search adds `limit` itself;
 * any extra keys on the input are ignored.
 */
export function toSearchFilters(input: LibraryFilterInput): SearchFilters {
  return {
    query: input.query,
    artist: input.artist,
    genre: input.genre,
    yearMin: input.year_min,
    yearMax: input.year_max,
    bpmMin: input.bpm_min,
    bpmMax: input.bpm_max,
    loved: input.loved,
    disliked: input.disliked,
    // Stars (1–5) → Music.app's 0–100 scale at the boundary.
    ratingMin: input.rating_min != null ? input.rating_min * 20 : undefined,
    minPlays: input.min_plays,
    maxPlays: input.max_plays,
    lastPlayedBefore: input.last_played_before,
    lastPlayedAfter: input.last_played_after,
    addedBefore: input.added_before,
    addedAfter: input.added_after,
    inPlaylist: input.in_playlist,
    locationKind: input.location_kind,
    excludeArtists: input.exclude_artists,
    excludeTracks: input.exclude_tracks,
  };
}

// A min/max pair is invalid only when both are present and inverted — zod can't
// express that across two optional fields. Labels are explicit because the
// facet names aren't uniform (year_min/year_max vs min_plays/max_plays).
function checkRange(
  min: number | undefined,
  max: number | undefined,
  minLabel: string,
  maxLabel: string,
): SelectaError | null {
  return min != null && max != null && min > max
    ? validationError(`${minLabel} must be ≤ ${maxLabel}`)
    : null;
}

/** Cross-field range checks shared by search and library_overview. */
export function validateFilterRanges(input: LibraryFilterInput): SelectaError | null {
  return (
    checkRange(input.year_min, input.year_max, 'year_min', 'year_max') ??
    checkRange(input.bpm_min, input.bpm_max, 'bpm_min', 'bpm_max') ??
    checkRange(input.min_plays, input.max_plays, 'min_plays', 'max_plays')
  );
}
