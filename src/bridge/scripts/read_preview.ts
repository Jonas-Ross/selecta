import { wrapJxaScript } from './wrap.js';
import { PLAIN_USER_PLAYLISTS_NAMED } from './write_playlist.js';

/** Read-only recovery: validate the exact inspected live sequence before adoption. */
export function buildReadPreviewScript(args: { name: string; expectedTrackIds: string[] }): string {
  return wrapJxaScript(
    args,
    `
    ${PLAIN_USER_PLAYLISTS_NAMED}
    const slots = plainUserPlaylistsNamed(args.name, 2);
    if (slots.length !== 1) return JSON.stringify({ previewConflict: true });
    const pl = slots[0];
    const ids = pl.tracks.length === 0 ? [] : pl.tracks.persistentID();
    if (JSON.stringify(ids) !== JSON.stringify(args.expectedTrackIds))
      return JSON.stringify({ previewConflict: true });
    return JSON.stringify({ persistentId: pl.persistentID(), trackCount: ids.length, trackPersistentIds: ids });
  `,
  );
}
