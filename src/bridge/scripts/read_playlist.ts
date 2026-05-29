// JXA snippet: read one Music.app playlist by persistent ID, emit RawPlaylist JSON.
// The wrapper (wrap.ts) handles arg interpolation and the run handler.

import { wrapJxaScript } from './wrap.js';

export function buildReadPlaylistScript(args: { persistentId: string }): string {
  return wrapJxaScript(
    args,
    `
      // Materialize the whose() result into a real array so .length/[0] are
      // plain JS operations.
      const matches = Music.playlists.whose({ persistentID: args.persistentId })();
      if (matches.length === 0) {
        throw new Error('No playlist with persistent ID ' + args.persistentId);
      }
      const pl = matches[0];
      const cls = String(pl.class());
      let kind;
      if (cls === 'folderPlaylist') {
        kind = 'folder';
      } else {
        let smart = false;
        try { smart = pl.smart(); } catch (e) {}
        if (smart) kind = 'smart';
        else if (cls === 'userPlaylist' || cls === 'libraryPlaylist') kind = 'user';
        else kind = 'special';
      }
      // The bulk getter (one Apple event) returns IDs in playlist order, but it
      // raises errAENoSuchObject (-1728) on an empty collection — so short-circuit
      // empty (and folders, which have no own tracks) to [].
      let trackPersistentIds = [];
      if (kind !== 'folder' && pl.tracks.length > 0) {
        trackPersistentIds = pl.tracks.persistentID();
      }
      const result = {
        persistentId: pl.persistentID(),
        name: pl.name(),
        kind: kind,
        trackPersistentIds: trackPersistentIds,
      };
      try {
        const parent = pl.parent();
        if (parent) result.parentPersistentId = parent.persistentID();
      } catch (e) {}
      return JSON.stringify(result);
    `,
  );
}
