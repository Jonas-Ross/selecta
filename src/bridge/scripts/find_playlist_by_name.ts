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
