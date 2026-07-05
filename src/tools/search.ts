// search — faceted query over the cached library.

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import {
  libraryFilterShape,
  parseInput,
  toApiTrack,
  toErrorEnvelope,
  toSearchFilters,
  validateFilterRanges,
  validationError,
  roundedCacheAge,
  type ApiTrack,
  type ToolDeps,
} from './common.js';

// The faceted filters are shared with library_overview (common.libraryFilterShape);
// search adds the result cap.
export const searchInputShape = {
  ...libraryFilterShape,
  limit: z.number().int().min(1).max(500).optional().describe('Default 50, max 500.'),
  dedupe: z
    .boolean()
    .optional()
    .describe(
      'Collapse copies of the same song (same title + artist, e.g. album vs compilation) to one row; the suppressed copies come back in that row\'s alternate_ids. Distinct titles (remix/live/edit) never collapse. Default off — duplicates stay visible.',
    ),
  sort: z
    .enum(['most_played', 'least_played', 'recently_added', 'random', 'playlist_order'])
    .optional()
    .describe(
      "Result order. Omit for relevance (with query) or most-played. Use random / least_played / recently_added to dig past the top tracks when building a varied playlist. playlist_order (requires in_playlist) returns the playlist's own running order — use before positional add_tracks/remove_tracks.",
    ),
};

const SearchInput = z.strictObject(searchInputShape);

// search's track shape: the shared ApiTrack plus the dedupe-only alternates
// field — owned here because only a dedupe search can populate it.
export type SearchTrack = ApiTrack & {
  // Persistent IDs of the duplicate copies this row collapsed (same song,
  // other albums). Only present on a dedupe search, on rows that collapsed.
  alternate_ids?: string[];
};

export type SearchOutput = {
  tracks: SearchTrack[];
  total_matches: number;
  cache_age_hours: number | null;
};

export const SEARCH_DESCRIPTION = `Search the user's owned Apple Music library (local cache). All filters optional, ANDed together. Returns tracks with behavioral signal (play_count, skip_count, rating 0-5 stars, loved=favorited, last_played, date_added) — that signal is context for YOU to weigh, not a mandate. Ordering: with a free-text query, by relevance; otherwise by play count. Use the sort knob to escape the most-played pool — random for a fresh representative sample, least_played / recently_added (or last_played_before for forgotten gems) to dig into the long tail. When building a playlist, vary the lens so results don't collapse onto the same heavy-rotation tracks every time. Multi-source libraries hold duplicate copies of the same song (album + compilation + best-of): set dedupe true when building a tracklist so the same song can't ship twice — each collapsed row lists its suppressed copies in alternate_ids (the winner is a deterministic tiebreak: loved, then studio album over Various Artists compilation, then earliest year). Remix/live/edit versions have different titles and are never collapsed. An empty tracks array means the user owns nothing matching — broaden the search instead of retrying the same query. If cache_age_hours is null the cache has never been populated: call refresh_library once.`;

export async function handleSearch(
  raw: unknown,
  deps: ToolDeps,
): Promise<SearchOutput | SelectaError> {
  const parsed = parseInput(SearchInput, raw);
  if (!parsed.ok) return parsed.error;
  const input = parsed.data;
  const rangeError = validateFilterRanges(input);
  if (rangeError) return rangeError;
  if (input.sort === 'playlist_order' && input.in_playlist == null) {
    return validationError('sort playlist_order requires in_playlist.');
  }

  try {
    const { rows, total } = deps.cache().searchTracks({
      ...toSearchFilters(input),
      limit: input.limit,
      sort: input.sort,
      dedupe: input.dedupe,
    });
    return {
      tracks: rows.map((row) => ({ ...toApiTrack(row), alternate_ids: row.alternateIds })),
      total_matches: total,
      cache_age_hours: roundedCacheAge(deps),
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
