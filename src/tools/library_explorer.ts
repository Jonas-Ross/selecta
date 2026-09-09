import { z } from 'zod';
import { recentSinceIso } from '../cache/queries.js';
import {
  LibraryFilters,
  parseInput,
  toApiTrack,
  toErrorEnvelope,
  toSearchFilters,
  validateFilterRanges,
  type ToolDeps,
} from './common.js';
import { shapeOverview } from './library_overview.js';

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

    return {
      filters,
      sort,
      offset,
      limit,
      total_matches: total,
      next_offset: offset + rows.length < total ? offset + rows.length : null,
      tracks: rows.map(toApiTrack),
      overview: { ...overview, decades: overview.decades.slice(0, 30) },
      decades_other: {
        distinct: Math.max(0, stats.decades.length - 30),
        tracks: stats.decades.slice(30).reduce((n, d) => n + d.count, 0),
      },
      missing: {
        genre: total - stats.genres.reduce((n, g) => n + g.count, 0),
        year: total - stats.decades.reduce((n, d) => n + d.count, 0),
      },
    };
  } catch (error) {
    return toErrorEnvelope(error);
  }
}
