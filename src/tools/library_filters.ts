import { z } from 'zod';
import type { SearchFilters } from '../types/cache.js';
import type { SelectaError } from '../types/errors.js';
import { validationError } from './errors.js';

// ── Shared faceted filters (search + library_overview) ──────────────────────
// Both tools accept the same optional facets, ANDed. search adds `limit`;
// library_overview takes the bare shape. Defined once here so the two surfaces
// can't drift — and so adding a facet (e.g. bpm_min/bpm_max) is a one-line
// change both tools pick up.

// Anchor the date portion: bare YYYY-MM-DD or a full ISO timestamp (…T…), but
// not a date with a junk suffix like "2026-01-01nonsense".
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:$|T)/, 'expected an ISO date (YYYY-MM-DD…)');

export const libraryFilterShape = {
  query: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Free text over title/artist/album, relevance-ranked. Multi-word terms AND together.',
    ),
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
  loved: z
    .boolean()
    .optional()
    .describe('true → only favorited tracks; false → only non-favorited.'),
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
