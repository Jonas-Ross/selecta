// library_overview — the "shape of the crate" (post-v1). Aggregate counts and
// distributions over the whole library or a filtered slice, so the model can
// orient before searching. Pure grounding: counts are RAW (no genre merging),
// and top_artists is "most tracks owned", a fact — never a taste ranking.

import type { SelectaError } from '../types/errors.js';
import type { OverviewStats } from '../types/cache.js';
import {
  LibraryFilters,
  libraryFilterShape,
  parseInput,
  toErrorEnvelope,
  toSearchFilters,
  validateFilterRanges,
  roundedCacheAge,
  type ToolDeps,
} from './common.js';

// Same faceted filters as search, minus `limit` (an overview aggregates the
// whole match set). Reused verbatim so the two surfaces never drift.
export const libraryOverviewInputShape = libraryFilterShape;

// The long tail of genres beyond this is rolled into genres_other so a
// fragmented library can't blow the token budget.
export const GENRE_CAP = 50;

export type LibraryOverviewOutput = {
  filtered: boolean;
  total_tracks: number;
  total_runtime_seconds: number;
  total_runtime_human: string;
  tracks_with_bpm: number;
  genres: { name: string; count: number }[];
  genres_other?: { distinct: number; tracks: number };
  decades: { decade: string; count: number }[];
  top_artists: { name: string; track_count: number }[];
  artists_total: number;
  signal: {
    loved: number;
    disliked: number;
    rated: number;
    unrated: number;
    never_played: number;
    rating_histogram: Record<string, number>;
  };
  location: { local: number; cloud: number; missing?: number; unknown?: number };
  date_added_range: { earliest: string; latest: string } | null;
  cache_age_hours: number | null;
};

export const LIBRARY_OVERVIEW_DESCRIPTION = `Aggregate shape of the owned library, or a filtered slice: total tracks + runtime, genre distribution, decade histogram, top artists by track count, signal coverage (loved/rated/never-played + rating histogram), location split, and tracks_with_bpm (how much of the slice has a known tempo — gauge whether bpm filtering is viable before relying on it). Use it to orient before vibe-only requests, then search the slices. Same optional filters as search (all ANDed, no limit); none → whole library. Counts are RAW — genres are NOT normalized ("Hip-Hop" vs "Hip-Hop/Rap" stay separate), and top_artists is "most tracks owned", not a recommendation. genres caps at 50 (rest in genres_other), top_artists at 25 (artists_total carries the full count). cache_age_hours null → cache empty, call refresh_library once.`;

// 100 → "5", 90 → "4.5". Music stores half-stars as multiples of 10.
function formatStars(rating: number): string {
  const stars = rating / 20;
  return Number.isInteger(stars) ? String(stars) : stars.toFixed(1);
}

// Top two units only — "9d 9h", "4h 12m", "37m". Seconds are noise at library
// scale; 0 reads as "0m".
function humanizeDuration(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Shape the raw cache aggregates into the wire response: cap/roll-up genres,
 * format decades and runtime, build the rating histogram and location split.
 * Pure — split out so the capping and formatting are unit-testable without a DB.
 */
export function shapeOverview(
  stats: OverviewStats,
  opts: { filtered: boolean; cacheAgeHours: number | null },
): LibraryOverviewOutput {
  const genres = stats.genres.slice(0, GENRE_CAP);
  const overflow = stats.genres.slice(GENRE_CAP);

  const ratingHistogram: Record<string, number> = {};
  for (const { rating, count } of stats.ratingHistogram) {
    ratingHistogram[formatStars(rating)] = count;
  }

  const location: LibraryOverviewOutput['location'] = { local: stats.local, cloud: stats.cloud };
  if (stats.missing > 0) location.missing = stats.missing;
  if (stats.unknownLocation > 0) location.unknown = stats.unknownLocation;

  return {
    filtered: opts.filtered,
    total_tracks: stats.totalTracks,
    total_runtime_seconds: stats.totalRuntimeSeconds,
    total_runtime_human: humanizeDuration(stats.totalRuntimeSeconds),
    tracks_with_bpm: stats.withBpm,
    genres,
    ...(overflow.length > 0
      ? {
          genres_other: {
            distinct: overflow.length,
            tracks: overflow.reduce((sum, g) => sum + g.count, 0),
          },
        }
      : {}),
    decades: stats.decades.map((d) => ({ decade: `${d.decade}s`, count: d.count })),
    top_artists: stats.topArtists.map((a) => ({ name: a.name, track_count: a.trackCount })),
    artists_total: stats.artistsTotal,
    signal: {
      loved: stats.loved,
      disliked: stats.disliked,
      rated: stats.rated,
      unrated: stats.unrated,
      never_played: stats.neverPlayed,
      rating_histogram: ratingHistogram,
    },
    location,
    date_added_range:
      stats.earliestAdded != null && stats.latestAdded != null
        ? { earliest: stats.earliestAdded, latest: stats.latestAdded }
        : null,
    cache_age_hours: opts.cacheAgeHours,
  };
}

export async function handleLibraryOverview(
  raw: unknown,
  deps: ToolDeps,
): Promise<LibraryOverviewOutput | SelectaError> {
  const parsed = parseInput(LibraryFilters, raw);
  if (!parsed.ok) return parsed.error;
  const input = parsed.data;
  const rangeError = validateFilterRanges(input);
  if (rangeError) return rangeError;

  try {
    const stats = deps.cache().getOverview(toSearchFilters(input));
    return shapeOverview(stats, {
      filtered: Object.keys(input).length > 0,
      cacheAgeHours: roundedCacheAge(deps),
    });
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
