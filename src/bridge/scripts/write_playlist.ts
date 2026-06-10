// JXA snippets for the two write paths (docs/design.md §create_playlist /
// §preview_playlist). Tracks are resolved with whose({persistentID}) — one
// filtered Apple event per unique ID. Slower than an index map, but positional
// indexing (lib.tracks[i]) does NOT follow the bulk persistentID() read order
// (observed diverging on a real library, silently adding the wrong track), so
// whose() is the only correct resolver. duplicate() then adds each track —
// it works for cloud tracks where add() (file paths) would not, and the call
// order preserves the requested track order.
//
// If any requested ID is missing from the live library the script returns
// { missingTrackIds } BEFORE touching anything; the bridge maps that to
// track_not_found ("cache is stale").

import { wrapJxaScript } from './wrap.js';

const RESOLVE_AND_ADD_HELPERS = `
  const lib = Music.libraryPlaylists[0];
  const trackById = {};
  const missing = [];
  for (let i = 0; i < args.trackIds.length; i++) {
    const id = args.trackIds[i];
    if (id in trackById) continue;
    const matches = lib.tracks.whose({ persistentID: id })();
    if (matches.length === 0) missing.push(id);
    else trackById[id] = matches[0];
  }
  if (missing.length > 0) {
    return JSON.stringify({ missingTrackIds: missing });
  }
  function addTracksInOrder(pl) {
    for (let i = 0; i < args.trackIds.length; i++) {
      trackById[args.trackIds[i]].duplicate({ to: pl });
    }
  }
  function writeResult(pl) {
    return JSON.stringify({ persistentId: pl.persistentID(), trackCount: pl.tracks.length });
  }
`;

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
      addTracksInOrder(pl);
      return writeResult(pl);
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
      addTracksInOrder(pl);
      return writeResult(pl);
    `,
  );
}
