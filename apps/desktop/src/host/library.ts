// The crate: a page of the cached library for the user to dig through. Same
// search as the MCP tool, but each track carries the provenance the rail shows.
import { z } from 'zod';
import type { SelectaCache } from '@selecta/core/cache/index.js';
import { toApiTrack, toInspectedTrack } from '@selecta/core/domain/track_projections.js';
import type { TrackRow } from '@selecta/core/types/cache.js';
import { CRATE_ORDERS, type Crate, type CrateTrack } from '../shared/protocol.js';

// Enough to dig through by hand; past this the search box is the better tool.
export const CRATE_LIMIT = 300;

export const CrateQuery = z.strictObject({
  query: z.string().trim().max(200).optional(),
  order: z.enum(CRATE_ORDERS).optional(),
});

/** A cached track with the provenance the rail shows, plus what the crate's card adds. */
export function crateTrack(row: TrackRow): CrateTrack {
  const { genre, year } = toApiTrack(row);

  return { ...toInspectedTrack(row), genre, year };
}

export function crate(cache: SelectaCache, raw: unknown): Crate {
  const parsed = CrateQuery.parse(raw ?? {});
  const query = parsed.query || undefined;
  const order = parsed.order ?? 'recently_added';
  // Copies of one song would read as the same record twice.
  const { rows, total } = cache.searchTracks({
    query,
    limit: CRATE_LIMIT,
    dedupe: true,
    sort: query ? undefined : order,
  });

  return {
    tracks: rows.map(crateTrack),
    total,
    order: query ? 'relevance' : order,
  };
}
