// MCP input/output adapter for the shared refresh operation.

import { z } from 'zod';
import { RECONCILE_WINDOW_MINUTES } from '../cache/index.js';
import type { SelectaError } from '../types/errors.js';
import { parseInput, toErrorEnvelope } from './errors.js';
import type { ToolDeps } from './deps.js';
import { refreshLibrary } from '../operations/refresh.js';
export type { SyncReconciliation, RefreshLibraryOutput } from '../operations/refresh.js';

export { RECONCILE_WINDOW_MINUTES };

export const refreshLibraryInputShape = {};

const RefreshLibraryInput = z.strictObject(refreshLibraryInputShape);

export const REFRESH_LIBRARY_DESCRIPTION = `Reread the entire Music.app library into the local cache. Takes seconds to a minute depending on library size, and requires Music.app automation permission. Only call when the user asks for a refresh, when cache_age_hours is null (never populated), or when stale-cache errors (track_not_found) suggest the library changed. Also worth one call a few minutes after create_playlist: it reconciles unambiguous rekeys and reports identical copies under sync_reconciliation.ambiguous; refresh never deletes playlists. Ask the user which ambiguous copy to keep before calling delete_playlist and reports what it did in sync_reconciliation. A rekey carrying note_conflict: true landed on a playlist that already had its own note: that note stands and the rekeyed playlist's note did NOT travel, so re-read the note via list_playlists before assuming what it says. It also means the rekeyed creation ID is now unusable for edits — add_tracks/remove_tracks/reorder_tracks/delete_playlist/set_note refuse it with playlist_rekey_conflict, since the destination could be the user's own older playlist rather than the one created — re-resolve the real target via list_playlists/search. audio_features_pending in the response counts tracks enrich_features hasn't attempted yet (a refresh never wipes existing features). Each refresh also records per-track play/skip deltas since the previous one (play_deltas_recorded) — the play-history record behind recent_activity and the recent_plays sort; more regular refreshes give it finer grain. Never call it routinely before searches.`;

export async function handleRefreshLibrary(
  raw: unknown,
  deps: ToolDeps,
): Promise<import('../operations/refresh.js').RefreshLibraryOutput | SelectaError> {
  const parsed = parseInput(RefreshLibraryInput, raw ?? {});

  if (!parsed.ok) return parsed.error;

  try {
    return await refreshLibrary(deps.cache(), deps.bridge);
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
