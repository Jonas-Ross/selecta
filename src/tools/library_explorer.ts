import { capDistribution } from '../domain/distributions.js';
import { z } from 'zod';
import { recentSinceIso } from '../domain/recent_activity.js';
import { LibraryFilters, toSearchFilters, validateFilterRanges } from './library_filters.js';
import { parseInput, toErrorEnvelope } from './errors.js';
import { toApiTrack } from '../domain/track_projections.js';
import type { ToolDeps } from './deps.js';
import { shapeOverview } from '../domain/library_overview.js';

export const explorerInputShape = {
  filters: LibraryFilters.optional().describe(
    'Same ANDed filters as search and library_overview. Default: whole owned library.',
  ),
  sort: z.enum(['recently_added', 'least_played', 'most_played']).optional(),
  offset: z
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .optional()
    .describe('Zero-based page offset. Reset to 0 after changing filters or refreshing.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Page size, default 25, max 50. No deduplication.'),
};
const ExplorerInput = z.strictObject(explorerInputShape);

export const EXPLORER_DESCRIPTION = `Open an interactive owned-library explorer: clickable raw-genre and decade distributions, never-played/loved/recently-added filters, paginated tracks, and seed selection for an explicit curation request. Reads only the cache. Uses search/library_overview filter semantics; genre matching is case-insensitive but raw genre counts stay distinct. Charts describe the entire filtered slice; genres cap at 50 and decades at 30, with overflow and missing facts reported. Tracks page at 25 (max 50), without deduplication or taste ranking. Selection is temporary UI state, not a request by itself. The user's Ask agent action sends exact selected IDs and filters; create a proposal only, never infer a Music.app write. Works as JSON without UI. Cache refresh is a separate explicit action. Recent activity is captured between manual refreshes, not continuous listening history.`;

export async function handleLibraryExplorer(raw: unknown, deps: ToolDeps) {
  const parsed = parseInput(ExplorerInput, raw);

  if (!parsed.ok) return parsed.error;

  const { filters = {}, sort = 'recently_added', offset = 0, limit = 25 } = parsed.data;
  const error = validateFilterRanges(filters);

  if (error) return error;

  try {
    const cache = deps.cache();
    const query = toSearchFilters(filters);
    const recentSince = recentSinceIso();
    const { stats, rows, total, cacheAgeHours } = cache.exploreTracks(
      { ...query, sort, offset, limit },
      recentSince,
    );
    const overview = shapeOverview(stats, {
      filtered: Object.keys(filters).length > 0,
      cacheAgeHours: cacheAgeHours === null ? null : Math.round(cacheAgeHours * 100) / 100,
      recentSince,
    });

    const decades = capDistribution(overview.decades, 30);

    return {
      filters,
      sort,
      offset,
      limit,
      total_matches: total,
      next_offset: offset + rows.length < total ? offset + rows.length : null,
      tracks: rows.map(toApiTrack),
      overview: { ...overview, decades: decades.shown },
      decades_other: decades.other,
      missing: {
        genre: total - stats.genres.reduce((n, g) => n + g.count, 0),
        year: total - stats.decades.reduce((n, d) => n + d.count, 0),
      },
    };
  } catch (error) {
    return toErrorEnvelope(error);
  }
}
