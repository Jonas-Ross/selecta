import { withOperation } from './lock.js';
import { SelectaCache, RECONCILE_WINDOW_MINUTES } from '../cache/index.js';
import type { Bridge } from '../types/bridge.js';
import { formatReconciliationSummary } from '../diagnostics/status.js';
import { log } from '../log.js';
import { PREVIEW_PLAYLIST_NAME } from './playlist.js';

export type SyncReconciliation = {
  ambiguous: { name: string; playlist_ids: string[] }[];
  rekeys: { name: string; from_id: string; to_id: string }[];
  duplicates_removed: { name: string; deleted_id: string; kept_id: string }[];
  failures: { name: string; playlist_id: string; error: string }[];
};

export type RefreshLibraryOutput = {
  duration_ms: number;
  track_count: number;
  playlist_count: number;
  refreshed_at: string;
  // Tracks enrich_features has never attempted — newly added tracks land
  // here, so the model can see when a top-up run is worthwhile.
  audio_features_pending: number;
  // Play-history capture (issue #31): tracks whose play/skip counters rose
  // since the previous refresh (one history window each). play_count_resets
  // appears only when a counter went DOWN (re-import/iCloud weirdness) — the
  // baseline was re-established, nothing recorded.
  play_deltas_recorded: number;
  play_count_resets?: number;
  sync_reconciliation?: SyncReconciliation;
};

export async function refreshLibrary(
  cache: SelectaCache,
  bridge: Bridge,
): Promise<RefreshLibraryOutput> {
  return withOperation(cache, 'music', async () => {
    const started = Date.now();
    const snapshot = await bridge.readLibrary();
    const durationMs = Date.now() - started;

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

    const actions = cache.planSyncReconciliation({
      windowMinutes: RECONCILE_WINDOW_MINUTES,
      reservedSlotNames: [PREVIEW_PLAYLIST_NAME],
    });
    const reconciliation: SyncReconciliation = {
      rekeys: [],
      duplicates_removed: [],
      failures: [],
      ambiguous: [],
    };
    for (const action of actions) {
      if (action.kind === 'rekey') {
        cache.applyRekey(action.createdId, action.fromId, action.toId);
        reconciliation.rekeys.push({
          name: action.name,
          from_id: action.fromId,
          to_id: action.toId,
        });
        log.info(`[sync-reconcile] rekey "${action.name}": ${action.fromId} -> ${action.toId}`);
        continue;
      }
      reconciliation.ambiguous.push({ name: action.name, playlist_ids: action.playlistIds });
    }

    cache.appendRefreshNote(
      result.refreshedAt,
      formatReconciliationSummary({
        rekeys: reconciliation.rekeys.length,
        duplicates_removed: reconciliation.duplicates_removed.length,
        failures: reconciliation.failures.length,
      }),
    );

    return {
      duration_ms: durationMs,
      track_count: result.trackCount,
      playlist_count: result.playlistCount,
      refreshed_at: result.refreshedAt,
      audio_features_pending: cache.countPendingEnrichment(),
      play_deltas_recorded: result.playDeltasRecorded,
      ...(result.playCountResets > 0 ? { play_count_resets: result.playCountResets } : {}),
      ...(actions.length > 0 ? { sync_reconciliation: reconciliation } : {}),
    };
  });
}
