// search — faceted query over the cached library (docs/design.md §search).

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import {
  libraryFilterShape,
  parseInput,
  toApiTrack,
  toErrorEnvelope,
  toSearchFilters,
  validateFilterRanges,
  roundedCacheAge,
  type ApiTrack,
  type ToolDeps,
} from './common.js';

// The faceted filters are shared with library_overview (common.libraryFilterShape);
// search adds the result cap.
export const searchInputShape = {
  ...libraryFilterShape,
  limit: z.number().int().min(1).max(500).optional().describe('Default 50, max 500.'),
  sort: z
    .enum(['most_played', 'least_played', 'recently_added', 'random'])
    .optional()
    .describe(
      'Result order. Omit for relevance (with query) or most-played. Use random / least_played / recently_added to dig past the top tracks when building a varied playlist.',
    ),
};

const SearchInput = z.strictObject(searchInputShape);

export type SearchOutput = {
  tracks: ApiTrack[];
  total_matches: number;
  cache_age_hours: number | null;
};

export const SEARCH_DESCRIPTION = `Search the user's owned Apple Music library (local cache). All filters optional, ANDed together. Returns tracks with behavioral signal (play_count, skip_count, rating 0-5 stars, loved=favorited, last_played, date_added) — that signal is context for YOU to weigh, not a mandate. Ordering: with a free-text query, by relevance; otherwise by play count. Use the sort knob to escape the most-played pool — random for a fresh representative sample, least_played / recently_added (or last_played_before for forgotten gems) to dig into the long tail. When building a playlist, vary the lens so results don't collapse onto the same heavy-rotation tracks every time. An empty tracks array means the user owns nothing matching — broaden the search instead of retrying the same query. If cache_age_hours is null the cache has never been populated: call refresh_library once.`;

export async function handleSearch(
  raw: unknown,
  deps: ToolDeps,
): Promise<SearchOutput | SelectaError> {
  const parsed = parseInput(SearchInput, raw);
  if (!parsed.ok) return parsed.error;
  const input = parsed.data;
  const rangeError = validateFilterRanges(input);
  if (rangeError) return rangeError;

  try {
    const { rows, total } = deps.cache().searchTracks({
      ...toSearchFilters(input),
      limit: input.limit,
      sort: input.sort,
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
