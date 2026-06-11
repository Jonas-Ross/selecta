// JXA snippet: resolve a playlist's persistent ID by name. Test-support for the
// opt-in integration test (targets a hand-set-up "Selecta Test" playlist without
// hardcoding an ID). Emits the persistent ID string, or null if no match.

import { wrapJxaScript } from './wrap.js';

export function buildFindPlaylistByNameScript(args: { name: string }): string {
  return wrapJxaScript(
    args,
    `
      // Invoke the whose() specifier to materialize a real array (see read_playlist).
      const matches = Music.playlists.whose({ name: args.name })();
      if (matches.length === 0) return JSON.stringify(null);
      return JSON.stringify(matches[0].persistentID());
    `,
  );
}

// List ALL playlists with a given name (ID + track count). Test/diagnostic
// support: the echo-verification script polls this to watch an iCloud echo
// twin arrive — far cheaper than a full library read every 15 seconds.
export function buildListPlaylistsByNameScript(args: { name: string }): string {
  return wrapJxaScript(
    args,
    `
      const matches = Music.playlists.whose({ name: args.name })();
      return JSON.stringify(
        matches.map((m) => ({ persistentId: m.persistentID(), trackCount: m.tracks.length })),
      );
    `,
  );
}
