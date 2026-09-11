import { capDistribution } from './distributions.js';
import type { OverviewStats } from '../types/cache.js';
import { RECENT_WINDOW_DAYS } from './recent_activity.js';

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
  // Play-history deltas recorded in the recent window (issue #31), scoped to
  // the same filtered slice. Deltas only exist where refreshes bracketed the
  // listening — "activity captured since", never a per-day rate.
  recent_activity: {
    window_days: number;
    since: string;
    tracks_played: number;
    total_plays: number;
    total_skips: number;
  };
  date_added_range: { earliest: string; latest: string } | null;
  cache_age_hours: number | null;
};

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
  opts: { filtered: boolean; cacheAgeHours: number | null; recentSince: string },
): LibraryOverviewOutput {
  const { shown: genres, other } = capDistribution(stats.genres, GENRE_CAP);

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
    ...(other.distinct > 0 ? { genres_other: other } : {}),
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
    recent_activity: {
      window_days: RECENT_WINDOW_DAYS,
      since: opts.recentSince,
      tracks_played: stats.recentActivity.tracksPlayed,
      total_plays: stats.recentActivity.totalPlays,
      total_skips: stats.recentActivity.totalSkips,
    },
    date_added_range:
      stats.earliestAdded != null && stats.latestAdded != null
        ? { earliest: stats.earliestAdded, latest: stats.latestAdded }
        : null,
    cache_age_hours: opts.cacheAgeHours,
  };
}
