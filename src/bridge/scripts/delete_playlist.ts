// JXA snippets for playlist deletion.
//
// Deletion by NAME is test-support only — integration tests and the smoke
// script clean up the scratch playlists they create. It sweeps by name, not
// persistent ID, because iCloud Music Library reassigns a freshly created
// playlist's persistent ID (and can resurrect a just-deleted one) when sync
// settles, so an ID captured at creation time is unreliable for cleanup. The
// loop also sweeps any resurrected copies from earlier runs.

import { wrapJxaScript } from './wrap.js';
import { PLAYLIST_KIND_FN } from './playlist_kind.js';

// Delete ONE playlist by persistent ID. Two production callers: the
// delete_playlist tool (ID resolved from the cache moments earlier) and
// refresh-time iCloud-echo reconciliation (ID observed in the library snapshot
// seconds earlier) — the transient-ID caveat above applies to IDs captured at
// creation time, not to ones just read back. Guards live editability like the
// edit scripts: only plain user playlists are deletable.
export function buildDeletePlaylistByIdScript(args: { persistentId: string }): string {
  return wrapJxaScript(
    args,
    `
      ${PLAYLIST_KIND_FN}
      const matches = Music.playlists.whose({ persistentID: args.persistentId })();
      if (matches.length === 0) return JSON.stringify({ deleted: 0 });
      if (playlistKind(matches[0]) !== 'user') {
        return JSON.stringify({ notEditable: true });
      }
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
