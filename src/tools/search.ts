// search — faceted query over the cached library (docs/design.md §search).

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import {
  parseInput,
  toApiTrack,
  toErrorEnvelope,
  validationError,
  roundedCacheAge,
  type ApiTrack,
  type ToolDeps,
} from './common.js';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'expected an ISO date (YYYY-MM-DD…)');

export const searchInputShape = {
  query: z
    .string()
    .min(1)
    .optional()
    .describe('Free text over title/artist/album, relevance-ranked. Multi-word terms AND together.'),
  artist: z.string().optional().describe('Exact artist name, case-insensitive.'),
  genre: z.string().optional().describe('Exact genre name, case-insensitive.'),
  year_min: z.number().int().optional(),
  year_max: z.number().int().optional(),
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
  limit: z.number().int().min(1).max(500).optional().describe('Default 50, max 500.'),
};

const SearchInput = z.strictObject(searchInputShape);

export type SearchOutput = {
  tracks: ApiTrack[];
  total_matches: number;
  cache_age_hours: number | null;
};

export const SEARCH_DESCRIPTION = `Search the user's owned Apple Music library (local cache). All filters optional, ANDed together. Returns tracks with behavioral signal (play_count, skip_count, rating 0-5 stars, loved=favorited, last_played, date_added). Without a free-text query, results are ordered by play count. An empty tracks array means the user owns nothing matching — broaden the search instead of retrying the same query. If cache_age_hours is null the cache has never been populated: call refresh_library once.`;

export async function handleSearch(
  raw: unknown,
  deps: ToolDeps,
): Promise<SearchOutput | SelectaError> {
  const parsed = parseInput(SearchInput, raw);
  if (!parsed.ok) return parsed.error;
  const input = parsed.data;
  if (input.year_min != null && input.year_max != null && input.year_min > input.year_max) {
    return validationError('year_min must be ≤ year_max');
  }
  if (input.min_plays != null && input.max_plays != null && input.min_plays > input.max_plays) {
    return validationError('min_plays must be ≤ max_plays');
  }

  try {
    const { rows, total } = deps.cache().searchTracks({
      query: input.query,
      artist: input.artist,
      genre: input.genre,
      yearMin: input.year_min,
      yearMax: input.year_max,
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
      limit: input.limit,
    });
    return {
      tracks: rows.map(toApiTrack),
      total_matches: total,
      cache_age_hours: roundedCacheAge(deps),
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
