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
  function writeResult(pl, persistentId, extra, mutate) {
    let failed = false;
    try { mutate(); } catch (e) { failed = true; }
    let trackPersistentIds;
    // Exactly one readback attempt, even when population failed.
    try { trackPersistentIds = pl.tracks.persistentID(); } catch (e) { failed = true; }
    if (failed) {
      return JSON.stringify({ partialWrite: {
        persistentId: persistentId, trackPersistentIds: trackPersistentIds,
      } });
    }
    return JSON.stringify(Object.assign({ persistentId: persistentId,
      trackCount: trackPersistentIds.length, trackPersistentIds: trackPersistentIds }, extra));
  }
`;

// Plain user playlists with exactly this name — never a smart playlist that
// happens to share it. The reserved preview slot is identified by name, so
// both the slot overwrite and the slot recovery below go through this. Each
// candidate costs two Apple events, so callers that need only one pass max.
const PLAIN_USER_PLAYLISTS_NAMED = `
  function plainUserPlaylistsNamed(name, max) {
    const matches = Music.userPlaylists.whose({ name: name })();
    const found = [];
    for (let i = 0; i < matches.length && found.length < max; i++) {
      const m = matches[i];
      let smart = false;
      try { smart = m.smart(); } catch (e) {}
      if (!smart && String(m.class()) === 'userPlaylist') found.push(m);
    }
    return found;
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
      const persistentId = pl.persistentID();
      return writeResult(pl, persistentId, {}, () => addTracksInOrder(pl, args.trackIds));
    `,
  );
}

export function buildClonePlaylistScript(args: {
  name: string;
  sourcePlaylistId: string;
  description?: string;
  reservedSourceName?: string;
}): string {
  return wrapJxaScript(
    args,
    `
      ${PLAYLIST_KIND_FN}
      ${PLAIN_USER_PLAYLISTS_NAMED}
      const sourceMatches = Music.playlists.whose({ persistentID: args.sourcePlaylistId })();
      let source = sourceMatches.length > 0 ? sourceMatches[0] : null;
      // ID gone live but vouched as a reserved slot: recover by exact name —
      // one plain user playlist, or refuse (docs/music-app.md, persistent IDs).
      if (source === null && args.reservedSourceName) {
        const slots = plainUserPlaylistsNamed(args.reservedSourceName, Infinity);
        if (slots.length > 1) {
          return JSON.stringify({
            ambiguousSource: {
              name: args.reservedSourceName,
              persistentIds: slots.map((s) => s.persistentID()),
            },
          });
        }
        if (slots.length === 1) source = slots[0];
      }
      if (source === null) {
        return JSON.stringify({ playlistNotFound: true });
      }
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
      ${WRITE_RESULT_HELPER}
      const pl = Music.make({ new: 'playlist', withProperties: { name: args.name } });
      if (args.description) {
        try { pl.description = args.description; } catch (e) {}
      }
      const persistentId = pl.persistentID();
      return writeResult(pl, persistentId, {
        sourcePersistentId: sourcePersistentId,
        sourceName: sourceName,
        sourceTrackPersistentIds: sourceTrackPersistentIds,
      }, () => addTracksInOrder(pl, sourceTrackPersistentIds));
    `,
  );
}

export function buildReplacePlaylistScript(args: { name: string; trackIds: string[] }): string {
  return wrapJxaScript(
    args,
    `
      ${RESOLVE_AND_ADD_HELPERS}
      ${PLAIN_USER_PLAYLISTS_NAMED}
      // Find-or-create by name, so the preview slot keeps a stable persistent
      // ID across overwrites.
      const slots = plainUserPlaylistsNamed(args.name, 2);
      if (slots.length > 1) return JSON.stringify({ ambiguousPreview: true });
      const created = slots.length === 0;
      const pl = created
        ? Music.make({ new: 'playlist', withProperties: { name: args.name } })
        : slots[0];
      const persistentId = pl.persistentID();
      return writeResult(pl, persistentId, { created: created }, () => {
        // Reverse order so positions stay valid while deleting.
        for (let i = pl.tracks.length - 1; i >= 0; i--) Music.delete(pl.tracks[i]);
        addTracksInOrder(pl, args.trackIds);
      });
    `,
  );
}
