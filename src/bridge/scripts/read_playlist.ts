// JXA snippet: read one Music.app playlist by persistent ID, emit RawPlaylist JSON.
// The wrapper (wrap.ts) handles arg interpolation and the run handler.

import { wrapJxaScript } from './wrap.js';

export function buildReadPlaylistScript(args: { persistentId: string }): string {
  return wrapJxaScript(
    args,
    `
      const matches = Music.playlists.whose({ persistentID: args.persistentId });
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
      const result = {
        persistentId: pl.persistentID(),
        name: pl.name(),
        kind: kind,
        // Bulk getter returns IDs in playlist order. Folders have no own tracks.
        trackPersistentIds: kind === 'folder' ? [] : pl.tracks.persistentID(),
      };
      try {
        const parent = pl.parent();
        if (parent) result.parentPersistentId = parent.persistentID();
      } catch (e) {}
      return JSON.stringify(result);
    `,
  );
}
