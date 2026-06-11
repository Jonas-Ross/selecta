// refresh_library — full Music.app reread into the cache. The only tool that
// repopulates the cache; write tools patch it surgically instead. After the
// reread it reconciles iCloud sync echoes of recently created playlists
// (docs/design.md §Implementation notes): rekeys are remapped in the creation
// receipt, echo duplicates are deleted in Music.app (keeping the iCloud-keyed
// survivor) and reported in the response — never silently.

import { z } from 'zod';
import { log } from '../log.js';
import type { SelectaError } from '../types/errors.js';
import { parseInput, toErrorEnvelope, type ToolDeps } from './common.js';

// Echo twins arrive ~10s–3min after creation; the window bounds how long a
// creation receipt can trigger a delete, so a later intentional copy of the
// same playlist is never touched. Generous vs. the observed echo latency to
// cover slow refresh habits, small vs. "intentional duplicate" timescales.
export const RECONCILE_WINDOW_MINUTES = 60;

export const refreshLibraryInputShape = {};

const RefreshLibraryInput = z.strictObject(refreshLibraryInputShape);

export type SyncReconciliation = {
  rekeys: { name: string; from_id: string; to_id: string }[];
  duplicates_removed: { name: string; deleted_id: string; kept_id: string }[];
  failures: { name: string; playlist_id: string; error: string }[];
};

export type RefreshLibraryOutput = {
  duration_ms: number;
  track_count: number;
  playlist_count: number;
  refreshed_at: string;
  sync_reconciliation?: SyncReconciliation;
};

export const REFRESH_LIBRARY_DESCRIPTION = `Reread the entire Music.app library into the local cache. Takes seconds to a minute depending on library size, and requires Music.app automation permission. Only call when the user asks for a refresh, when cache_age_hours is null (never populated), or when stale-cache errors (track_not_found) suggest the library changed. Also worth one call a few minutes after create_playlist: it reconciles iCloud sync echoes of recent creations (removes the duplicate copy, remaps rekeyed IDs) and reports what it did in sync_reconciliation. Never call it routinely before searches.`;

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
    const cache = deps.cache();

    // Observability for the iCloud-echo investigation: every playlist ID
    // observed in this read at debug level; playlists matching a recent
    // creation receipt at info level, so an echo's arrival is visible in the
    // log without SELECTA_DEBUG.
    const watched = new Set(cache.getRecentCreationNames(RECONCILE_WINDOW_MINUTES));
    for (const p of snapshot.playlists) {
      const line = `[library-read ${snapshot.capturedAt}] ${p.persistentId} "${p.name}" tracks=${p.trackPersistentIds.length}`;
      if (watched.has(p.name)) log.info(line);
      else log.debug(line);
    }

    const result = cache.refreshFromSnapshot(snapshot, { durationMs });

    const actions = cache.planSyncReconciliation({ windowMinutes: RECONCILE_WINDOW_MINUTES });
    const reconciliation: SyncReconciliation = {
      rekeys: [],
      duplicates_removed: [],
      failures: [],
    };
    for (const action of actions) {
      if (action.kind === 'rekey') {
        cache.applyRekey(action.createdId, action.toId);
        reconciliation.rekeys.push({ name: action.name, from_id: action.fromId, to_id: action.toId });
        log.info(`[sync-reconcile] rekey "${action.name}": ${action.fromId} -> ${action.toId}`);
        continue;
      }
      for (const deleteId of action.deleteIds) {
        try {
          const deleted = await deps.bridge.deletePlaylistById(deleteId);
          cache.applyDuplicateRemoval(action.createdId, deleteId, action.keepId);
          reconciliation.duplicates_removed.push({
            name: action.name,
            deleted_id: deleteId,
            kept_id: action.keepId,
          });
          log.info(
            `[sync-reconcile] duplicate "${action.name}": deleted ${deleteId} (${deleted} removed in Music.app), kept ${action.keepId}`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          reconciliation.failures.push({
            name: action.name,
            playlist_id: deleteId,
            error: message,
          });
          log.error(`[sync-reconcile] failed to delete "${action.name}" ${deleteId}: ${message}`);
        }
      }
    }

    return {
      duration_ms: durationMs,
      track_count: result.trackCount,
      // The only thing that can change the count between snapshot and response
      // is the deletes this very handler performed.
      playlist_count: result.playlistCount - reconciliation.duplicates_removed.length,
      refreshed_at: result.refreshedAt,
      ...(actions.length > 0 ? { sync_reconciliation: reconciliation } : {}),
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
