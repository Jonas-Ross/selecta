// JXA snippet: delete ALL playlists with a given name. Test-support only —
// used by integration tests and the smoke script to clean up the scratch
// playlists they create. Not part of the Bridge interface (v1 has no playlist
// deletion).
//
// Deletion is by NAME, not persistent ID: iCloud Music Library reassigns a
// freshly created playlist's persistent ID (and can resurrect a just-deleted
// one) when sync settles, so an ID captured at creation time is unreliable for
// cleanup. The loop also sweeps any resurrected copies from earlier runs.

import { wrapJxaScript } from './wrap.js';

export function buildDeletePlaylistsByNameScript(args: { name: string }): string {
  return wrapJxaScript(
    args,
    `
      let deleted = 0;
      let matches = Music.playlists.whose({ name: args.name })();
      while (matches.length > 0) {
        Music.delete(matches[0]);
        deleted++;
        matches = Music.playlists.whose({ name: args.name })();
      }
      return JSON.stringify({ deleted: deleted });
    `,
  );
}
