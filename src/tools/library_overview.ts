// library_overview — the "shape of the crate" (post-v1). Aggregate counts and
// distributions over the whole library or a filtered slice, so the model can
// orient before searching. Pure grounding: counts are RAW (no genre merging),
// and top_artists is "most tracks owned", a fact — never a taste ranking.

import type { SelectaError } from '../types/errors.js';
import { recentSinceIso } from '../domain/recent_activity.js';
import { shapeOverview, type LibraryOverviewOutput } from '../domain/library_overview.js';
import {
  LibraryFilters,
  libraryFilterShape,
  toSearchFilters,
  validateFilterRanges,
} from './library_filters.js';
import { parseInput, toErrorEnvelope } from './errors.js';
import { roundCacheAge } from './freshness.js';
import type { ToolDeps } from './deps.js';

// Same faceted filters as search, minus `limit` (an overview aggregates the
// whole match set). Reused verbatim so the two surfaces never drift.
export const libraryOverviewInputShape = libraryFilterShape;

export const LIBRARY_OVERVIEW_DESCRIPTION = `Aggregate shape of the owned library, or a filtered slice: total tracks + runtime, genre distribution, decade histogram, top artists by track count, signal coverage (loved/rated/never-played + rating histogram), location split, tracks_with_bpm (how much of the slice has a known tempo — gauge whether bpm filtering is viable before relying on it), and recent_activity (plays/skips captured by refreshes in the last 30 days — zeros mean no refresh bracketed recent listening, not necessarily silence). Use it to orient before vibe-only requests, then search the slices. Same optional filters as search (all ANDed, no limit); none → whole library. Counts are RAW — genres are NOT normalized ("Hip-Hop" vs "Hip-Hop/Rap" stay separate), and top_artists is "most tracks owned", not a recommendation. genres caps at 50 (rest in genres_other), top_artists at 25 (artists_total carries the full count). cache_age_hours null → cache empty, call refresh_library once.`;

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
    const recentSince = recentSinceIso();

    const { stats, cacheAgeHours } = deps
      .cache()
      .overviewSnapshot(toSearchFilters(input), recentSince);

    return shapeOverview(stats, {
      filtered: Object.keys(input).length > 0,
      cacheAgeHours: roundCacheAge(cacheAgeHours),
      recentSince,
    });
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
