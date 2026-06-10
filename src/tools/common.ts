// Shared tool-handler plumbing (docs/contracts.md §6): the deps bundle, the
// cache-row → API-track mapping, and error envelope conversion. Handlers are
// plain async functions returning output-or-SelectaError — the only layer that
// knows MCP exists is server.ts, and even it only wraps these.

import type { z } from 'zod';
import type { Bridge } from '../types/bridge.js';
import type { TrackRow } from '../types/cache.js';
import { BridgeError, defaultHints, type SelectaError } from '../types/errors.js';
import type { SelectaCache } from '../cache/index.js';

// cache is a lazy getter so a broken cache (unwritable dir, corrupt file)
// surfaces per-call as a cache_unavailable envelope instead of crashing the
// server at startup — and cold start stays under the 200ms budget.
export type ToolDeps = {
  cache: () => SelectaCache;
  bridge: Bridge;
};

// The model-facing track shape: identity fields plus the behavioral signal
// bundle. Ratings are 0–5 stars here (Music.app's 0–100 internally). Absent
// fields are omitted entirely — undefined keys disappear in JSON, and over a
// 50-track response the saved tokens add up.
export type ApiTrack = {
  persistent_id: string;
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  genre?: string;
  duration_seconds?: number;
  location_kind?: string;
  signal: {
    play_count: number;
    skip_count: number;
    rating?: number; // 0..5 stars
    loved?: true;
    disliked?: true;
    last_played?: string;
    date_added?: string;
  };
};

export function toApiTrack(row: TrackRow): ApiTrack {
  return {
    persistent_id: row.persistentId,
    title: row.title ?? undefined,
    artist: row.artist ?? undefined,
    album: row.album ?? undefined,
    year: row.year ?? undefined,
    genre: row.genre ?? undefined,
    duration_seconds: row.durationSeconds ?? undefined,
    location_kind: row.locationKind ?? undefined,
    signal: {
      play_count: row.playCount,
      skip_count: row.skipCount,
      rating: row.rating != null ? row.rating / 20 : undefined,
      loved: row.loved === 1 ? true : undefined,
      disliked: row.disliked === 1 ? true : undefined,
      last_played: row.lastPlayed ?? undefined,
      date_added: row.dateAdded ?? undefined,
    },
  };
}

export function validationError(hint: string): SelectaError {
  return { error: 'validation_error', hint };
}

/** Shared zod parse → validation_error envelope, one format for every tool. */
export function parseInput<T>(
  schema: z.ZodType<T>,
  raw: unknown,
): { ok: true; data: T } | { ok: false; error: SelectaError } {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: validationError(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Pre-flight for write tools: every referenced track must exist in the cache.
 * Returns a track_not_found envelope naming the offenders, or null when all
 * resolve. The bridge re-checks against the live library; this catches model
 * mistakes (hallucinated/typo'd IDs) before any Apple event fires.
 */
export function missingTrackIdsError(cache: SelectaCache, trackIds: string[]): SelectaError | null {
  const missing = trackIds.filter((id) => cache.getTrack(id) === null);
  if (missing.length === 0) return null;
  const shown = missing.slice(0, 5).join(', ');
  const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
  return {
    error: 'track_not_found',
    hint: `Not in the cache: ${shown}${more}. Use persistent IDs exactly as returned by search/get_track_context; if the library changed, run refresh_library.`,
  };
}

/** Convert a thrown BridgeError to the wire envelope; rethrow anything else. */
export function toErrorEnvelope(err: unknown): SelectaError {
  if (err instanceof BridgeError) {
    return { error: err.errorCode, hint: err.hint ?? defaultHints[err.errorCode] };
  }
  throw err;
}

export function isSelectaError(value: object): value is SelectaError {
  return 'error' in value;
}

/** Round cache age for the wire — sub-minute precision is token noise. */
export function roundedCacheAge(deps: ToolDeps): number | null {
  const age = deps.cache().getCacheAgeHours();
  return age == null ? null : Math.round(age * 100) / 100;
}
