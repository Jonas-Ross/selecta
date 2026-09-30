import type { SelectaCache } from '../cache/index.js';
import type { PlaylistRow } from '../types/cache.js';
import { trackNotFoundError, type SelectaError } from '../types/errors.js';

/**
 * Pre-flight for write tools: every referenced track must exist in the cache.
 * Returns a track_not_found envelope naming the offenders, or null when all
 * resolve. The bridge re-checks against the live library; this catches model
 * mistakes (hallucinated/typo'd IDs) before any Apple event fires.
 */
export function missingTrackIdsError(cache: SelectaCache, trackIds: string[]): SelectaError | null {
  const missing = trackIds.filter((id) => cache.getTrack(id) === null);

  if (missing.length === 0) return null;

  return trackNotFoundError(missing);
}

/** Resolve a model-supplied playlist ID through creation receipts and cache. */
export function resolvePlaylist(
  cache: SelectaCache,
  playlistId: string,
): { ok: true; playlist: PlaylistRow } | { ok: false; error: SelectaError } {
  const playlist = cache.getPlaylist(cache.resolvePlaylistId(playlistId));

  if (playlist === null) {
    return {
      ok: false,
      error: {
        error: 'playlist_not_found',
        hint: `No playlist ${playlistId} in the cache. Use IDs exactly as returned by list_playlists; if the library changed, run refresh_library.`,
      },
    };
  }

  return { ok: true, playlist };
}

/**
 * A creation receipt's rekey can land on the user's own pre-existing
 * same-name playlist (see SelectaCache.applyRekey); writing through that ID
 * would silently hit the wrong playlist, so edit tools refuse it instead.
 */
export function playlistEditConflictError(
  cache: SelectaCache,
  playlistId: string,
): SelectaError | null {
  if (!cache.hasEditConflict(playlistId)) return null;

  return {
    error: 'playlist_rekey_conflict',
    hint: `Playlist ${playlistId}'s creation receipt rekeyed onto a playlist that already existed under a different ID — it could be the wrong target. Re-resolve via list_playlists/search and use the resolved ID directly.`,
  };
}

/**
 * Pre-flight for playlist-edit tools: refuse a conflicted receipt, resolve
 * the cached target, then require a plain user playlist. The bridge repeats
 * the kind check against Music.app.
 */
export function resolveEditablePlaylist(
  cache: SelectaCache,
  playlistId: string,
): { ok: true; playlist: PlaylistRow } | { ok: false; error: SelectaError } {
  const conflict = playlistEditConflictError(cache, playlistId);

  if (conflict) return { ok: false, error: conflict };

  const resolved = resolvePlaylist(cache, playlistId);

  if (!resolved.ok) return resolved;

  const { playlist } = resolved;

  if (playlist.kind !== 'user') {
    return {
      ok: false,
      error: {
        error: 'playlist_not_editable',
        hint: `"${playlist.name}" is a ${playlist.kind} playlist — only plain user playlists can be edited.`,
      },
    };
  }

  return { ok: true, playlist };
}
