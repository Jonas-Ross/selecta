// search — faceted query over the cached library.

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import {
  COMPACT_TRACK_FIELDS,
  libraryFilterShape,
  parseInput,
  projectApiTrack,
  toErrorEnvelope,
  toSearchFilters,
  validateFilterRanges,
  validationError,
  roundedCacheAge,
  type ApiTrack,
  type CompactApiTrack,
  type ToolDeps,
} from './common.js';

// The faceted filters are shared with library_overview (common.libraryFilterShape);
// search adds the result cap.
export const searchInputShape = {
  ...libraryFilterShape,
  compact: z
    .boolean()
    .optional()
    .describe(
      'Use for broad discovery: tracks become fixed value rows aligned with top-level track_fields; preserves IDs, identity, genre, behavioral signal (including date_added), audio features, and alternate_ids; omits only location_kind. Default false returns full track objects.',
    ),
  limit: z.number().int().min(1).max(500).optional().describe('Default 50, max 500.'),
  dedupe: z
    .boolean()
    .optional()
    .describe(
      "Collapse copies of the same song (same title + artist, e.g. album vs compilation) to one row; the suppressed copies come back in that row's alternate_ids. Distinct titles (remix/live/edit) never collapse. Default off — duplicates stay visible.",
    ),
  sort: z
    .enum([
      'most_played',
      'least_played',
      'recently_added',
      'random',
      'playlist_order',
      'recent_plays',
    ])
    .optional()
    .describe(
      'Result order. Omit for relevance (with query) or most-played. Use random / least_played / recently_added to dig past the top tracks when building a varied playlist. recent_plays orders by plays recorded in the last 30 days of refreshes (current rotation, not lifetime count) — needs refresh history to exist; without it everything ties at zero. playlist_order (requires in_playlist) returns playlist_positions on each row: the actual zero-based entry positions, including repeated occurrences. Use these positions for edits, NEVER the result-array index; filters and unavailable tracks can leave gaps.',
    ),
};

const SearchInput = z.strictObject(searchInputShape);

// search's track shape: the shared ApiTrack plus the dedupe-only alternates
// field — owned here because only a dedupe search can populate it.
export type SearchTrack = ApiTrack & {
  // Persistent IDs of the duplicate copies this row collapsed (same song,
  // other albums). Only present on a dedupe search, on rows that collapsed.
  alternate_ids?: string[];
  playlist_positions?: number[];
};

export type SearchOutput = {
  tracks: SearchTrack[];
  total_matches: number;
  cache_age_hours: number | null;
};

export type CompactSearchOutput = {
  track_fields: typeof COMPACT_TRACK_FIELDS;
  tracks: { track: CompactApiTrack; alternate_ids?: string[]; playlist_positions?: number[] }[];
  total_matches: number;
  cache_age_hours: number | null;
};

export const SEARCH_DESCRIPTION = `Search the user's owned Apple Music library (local cache). All filters optional, ANDed together. Returns tracks with behavioral signal (play_count, skip_count, rating 0-5 stars, loved=favorited, last_played, date_added) — that signal is context for YOU to weigh, not a mandate. Tracks also carry enriched audio features where known: bpm, musical_key (e.g. "F# minor"), danceability (0-1) — raw facts for tempo/key-aware sequencing; absent fields mean the track has no data yet (coverage is partial, never assume). A note field is your own earlier set_note memory on that track, verbatim — Selecta never filters or orders on it. Set compact true for broad discovery across many results. Compact tracks are fixed value rows under each track key, aligned positionally with the top-level track_fields array; null means that fact is unavailable. The rows preserve persistent_id, title, artist, album, year, genre, duration_seconds, the complete comparison signal (including date_added), and audio features; alternate_ids stays beside its row. Only location_kind is omitted. Omit compact for full track objects. Compact mode never changes ordering or silently truncates results. bpm_min/bpm_max filter to a tempo band; tracks with unknown tempo never match a bpm filter. Ordering: with a free-text query, by relevance; otherwise by play count. Use the sort knob to escape the most-played pool — random for a fresh representative sample, least_played / recently_added (or last_played_before for forgotten gems) to dig into the long tail, recent_plays for what's in current rotation. When building a playlist, vary the lens so results don't collapse onto the same heavy-rotation tracks every time. Multi-source libraries hold duplicate copies of the same song (album + compilation + best-of): set dedupe true when building a tracklist so the same song can't ship twice — each collapsed row lists its suppressed copies in alternate_ids (the winner is a deterministic tiebreak: loved, then studio album over Various Artists compilation, then earliest year). Remix/live/edit versions have different titles and are never collapsed. An empty tracks array means the user owns nothing matching — broaden the search instead of retrying the same query. If cache_age_hours is null the cache has never been populated: call refresh_library once.`;

export async function handleSearch(
  raw: unknown,
  deps: ToolDeps,
): Promise<SearchOutput | CompactSearchOutput | SelectaError> {
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
    const positions = new Map<string, number[]>();
    if (input.sort === 'playlist_order' && input.in_playlist != null) {
      const cache = deps.cache();
      cache
        .getPlaylistTrackIds(cache.resolvePlaylistId(input.in_playlist))
        .forEach((id, position) => {
          const list = positions.get(id) ?? [];
          list.push(position);
          positions.set(id, list);
        });
    }
    const entryPositions = (id: string) =>
      input.sort === 'playlist_order' ? { playlist_positions: positions.get(id) ?? [] } : {};
    const common = { total_matches: total, cache_age_hours: roundedCacheAge(deps) };
    if (input.compact === true) {
      return {
        track_fields: COMPACT_TRACK_FIELDS,
        tracks: rows.map((row) => ({
          track: projectApiTrack(row, true),
          alternate_ids: row.alternateIds,
          ...entryPositions(row.persistentId),
        })),
        ...common,
      };
    }
    return {
      tracks: rows.map((row) => ({
        ...projectApiTrack(row, false),
        alternate_ids: row.alternateIds,
        ...entryPositions(row.persistentId),
      })),
      ...common,
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
