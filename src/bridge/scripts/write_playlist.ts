// JXA snippets for the playlist creation paths.
// Track resolution is the shared RESOLVE_TRACKS snippet
// (see resolve_tracks.ts for the whose()-only rationale and the
// { missingTrackIds } guard). duplicate() then adds each track — it works for
// cloud tracks where add() (file paths) would not, and the call order
// preserves the requested track order.

import { wrapJxaScript } from './wrap.js';
import { RESOLVE_TRACKS, resolveTracks } from './resolve_tracks.js';
import { PLAYLIST_KIND_FN } from './playlist_kind.js';
import { PLAYLIST_WRITE_TRACK_LIMIT } from '../../types/bridge.js';

const ADD_HELPER = `
  function addTracksInOrder(pl, trackIds) {
    for (let i = 0; i < trackIds.length; i++) {
      trackById[trackIds[i]].duplicate({ to: pl });
    }
  }
`;

const WRITE_RESULT_HELPER = `
  function writeResult(pl) {
    return JSON.stringify({ persistentId: pl.persistentID(), trackCount: pl.tracks.length });
  }
`;

const RESOLVE_AND_ADD_HELPERS = `${RESOLVE_TRACKS}${ADD_HELPER}${WRITE_RESULT_HELPER}`;

export function buildCreatePlaylistScript(args: {
  name: string;
  trackIds: string[];
  description?: string;
}): string {
  return wrapJxaScript(
    args,
    `
      ${RESOLVE_AND_ADD_HELPERS}
      const pl = Music.make({ new: 'playlist', withProperties: { name: args.name } });
      if (args.description) {
        try { pl.description = args.description; } catch (e) {}
      }
      addTracksInOrder(pl, args.trackIds);
      return writeResult(pl);
    `,
  );
}

export function buildClonePlaylistScript(args: {
  name: string;
  sourcePlaylistId: string;
  description?: string;
}): string {
  return wrapJxaScript(
    args,
    `
      ${PLAYLIST_KIND_FN}
      const sourceMatches = Music.playlists.whose({ persistentID: args.sourcePlaylistId })();
      if (sourceMatches.length === 0) {
        return JSON.stringify({ playlistNotFound: true });
      }
      const source = sourceMatches[0];
      const sourceKind = playlistKind(source);
      if (sourceKind !== 'user') {
        return JSON.stringify({ sourceNotUser: true, sourceKind: sourceKind });
      }
      const liveTrackCount = source.tracks.length;
      if (liveTrackCount < 1 || liveTrackCount > ${PLAYLIST_WRITE_TRACK_LIMIT}) {
        return JSON.stringify({ invalidSourceTrackCount: liveTrackCount });
      }
      const sourceTrackPersistentIds = source.tracks.persistentID();
      // iCloud can change a playlist between Apple events. Recheck the
      // materialized snapshot so the earlier length guard cannot be raced.
      if (
        sourceTrackPersistentIds.length < 1 ||
        sourceTrackPersistentIds.length > ${PLAYLIST_WRITE_TRACK_LIMIT}
      ) {
        return JSON.stringify({ invalidSourceTrackCount: sourceTrackPersistentIds.length });
      }
      const sourcePersistentId = source.persistentID();
      const sourceName = source.name();

      ${resolveTracks('sourceTrackPersistentIds')}
      ${ADD_HELPER}
      const pl = Music.make({ new: 'playlist', withProperties: { name: args.name } });
      if (args.description) {
        try { pl.description = args.description; } catch (e) {}
      }
      addTracksInOrder(pl, sourceTrackPersistentIds);
      return JSON.stringify({
        persistentId: pl.persistentID(),
        trackCount: pl.tracks.length,
        sourcePersistentId: sourcePersistentId,
        sourceName: sourceName,
        sourceTrackPersistentIds: sourceTrackPersistentIds,
      });
    `,
  );
}

export function buildReplacePlaylistScript(args: { name: string; trackIds: string[] }): string {
  return wrapJxaScript(
    args,
    `
      ${RESOLVE_AND_ADD_HELPERS}
      // Find-or-create by name among plain user playlists (never a smart
      // playlist that happens to share the name), so the preview slot keeps a
      // stable persistent ID across overwrites.
      const matches = Music.userPlaylists.whose({ name: args.name })();
      let pl = null;
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        let smart = false;
        try { smart = m.smart(); } catch (e) {}
        if (!smart && String(m.class()) === 'userPlaylist') { pl = m; break; }
      }
      if (pl === null) {
        pl = Music.make({ new: 'playlist', withProperties: { name: args.name } });
      } else {
        // Reverse order so positions stay valid while deleting.
        for (let i = pl.tracks.length - 1; i >= 0; i--) Music.delete(pl.tracks[i]);
      }
      addTracksInOrder(pl, args.trackIds);
      return writeResult(pl);
    `,
  );
}
