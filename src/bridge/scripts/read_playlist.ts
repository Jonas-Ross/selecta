// JXA snippet: read one Music.app playlist by persistent ID, emit RawPlaylist JSON.
// Args are interpolated as JSON (valid JS), never via shell quoting — see
// docs/contracts.md §4. osascript prints the value of the final expression.

export function buildReadPlaylistScript(args: { persistentId: string }): string {
  return `
    const args = ${JSON.stringify(args)};
    function run() {
      const Music = Application('Music');
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
    }
    run();
  `;
}
