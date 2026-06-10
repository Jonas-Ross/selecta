// refresh_library — full Music.app reread into the cache. The only tool that
// repopulates the cache; write tools patch it surgically instead.

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import { parseInput, toErrorEnvelope, type ToolDeps } from './common.js';

export const refreshLibraryInputShape = {};

const RefreshLibraryInput = z.strictObject(refreshLibraryInputShape);

export type RefreshLibraryOutput = {
  duration_ms: number;
  track_count: number;
  playlist_count: number;
  refreshed_at: string;
};

export const REFRESH_LIBRARY_DESCRIPTION = `Reread the entire Music.app library into the local cache. Takes seconds to a minute depending on library size, and requires Music.app automation permission. Only call when the user asks for a refresh, when cache_age_hours is null (never populated), or when stale-cache errors (track_not_found) suggest the library changed. Never call it routinely before searches.`;

export async function handleRefreshLibrary(
  raw: unknown,
  deps: ToolDeps,
): Promise<RefreshLibraryOutput | SelectaError> {
  const parsed = parseInput(RefreshLibraryInput, raw ?? {});
  if (!parsed.ok) return parsed.error;

  try {
    const started = Date.now();
    const snapshot = await deps.bridge.readLibrary();
    const durationMs = Date.now() - started;
    const result = deps.cache().refreshFromSnapshot(snapshot, { durationMs });
    return {
      duration_ms: durationMs,
      track_count: result.trackCount,
      playlist_count: result.playlistCount,
      refreshed_at: result.refreshedAt,
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
