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

// Delete ONE playlist by persistent ID. Production use is refresh-time
// iCloud-echo reconciliation only, where the ID was observed in the library
// snapshot seconds earlier — the transient-ID caveat above applies to IDs
// captured at creation time, not to ones just read back.
export function buildDeletePlaylistByIdScript(args: { persistentId: string }): string {
  return wrapJxaScript(
    args,
    `
      const matches = Music.playlists.whose({ persistentID: args.persistentId })();
      if (matches.length === 0) return JSON.stringify({ deleted: 0 });
      Music.delete(matches[0]);
      return JSON.stringify({ deleted: 1 });
    `,
  );
}

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
