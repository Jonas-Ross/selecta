// Shared JXA snippet: classify a Music.app playlist into the RawPlaylist kind.
// Probed against a real library: special playlists (Library, Music) report a
// non-'none' specialKind; folders report specialKind 'folder'; Apple Music
// playlists the user added are class subscriptionPlaylist; smart playlists are
// class userPlaylist with smart() true — but smart() throws on classes that
// lack it, so it's guarded per-playlist (bulk smart() fails on mixed classes).

export const PLAYLIST_KIND_FN = `
  function playlistKind(pl) {
    let specialKind = 'none';
    try { specialKind = String(pl.specialKind()).toLowerCase(); } catch (e) {}
    if (specialKind === 'folder') return 'folder';
    if (specialKind !== 'none') return 'special';
    const cls = String(pl.class());
    if (cls === 'folderPlaylist') return 'folder';
    if (cls === 'subscriptionPlaylist') return 'subscription';
    if (cls === 'libraryPlaylist') return 'special';
    let smart = false;
    try { smart = pl.smart(); } catch (e) {}
    return smart ? 'smart' : 'user';
  }
`;
