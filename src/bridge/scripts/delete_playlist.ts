// JXA snippet: delete a playlist by persistent ID. Test-support only — used by
// integration tests to clean up the scratch playlists they create. Not part of
// the Bridge interface (v1 has no playlist deletion).

import { wrapJxaScript } from './wrap.js';

export function buildDeletePlaylistScript(args: { persistentId: string }): string {
  return wrapJxaScript(
    args,
    `
      const matches = Music.playlists.whose({ persistentID: args.persistentId })();
      if (matches.length === 0) {
        return JSON.stringify({ deleted: false });
      }
      Music.delete(matches[0]);
      return JSON.stringify({ deleted: true });
    `,
  );
}
