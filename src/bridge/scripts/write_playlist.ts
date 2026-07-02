// JXA snippets for the two write paths (docs/design.md §create_playlist /
// §preview_playlist). Track resolution is the shared RESOLVE_TRACKS snippet
// (see resolve_tracks.ts for the whose()-only rationale and the
// { missingTrackIds } guard). duplicate() then adds each track — it works for
// cloud tracks where add() (file paths) would not, and the call order
// preserves the requested track order.

import { wrapJxaScript } from './wrap.js';
import { RESOLVE_TRACKS } from './resolve_tracks.js';

const RESOLVE_AND_ADD_HELPERS = `
  ${RESOLVE_TRACKS}
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
