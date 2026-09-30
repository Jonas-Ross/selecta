import { PREVIEW_PLAYLIST_NAME } from '../../operations/playlist.js';
import { wrapJxaScript } from './wrap.js';

/** Reveal the reserved slot only when its live sequence matches the caller's draft. */
export function buildOpenPreviewScript(input: { expectedTrackIds: string[] }): string {
  return wrapJxaScript(
    { ...input, name: PREVIEW_PLAYLIST_NAME },
    `
      const matches = Music.playlists.whose({ name: args.name })()
        .filter(function (pl) { return pl.name() === args.name; });
      if (matches.length === 0) return JSON.stringify({ playlistNotFound: true });
      // Fail closed: unknown classes and unreadable identity properties are not targets.
      // Like preview creation, a smart playlist sharing the name is not a slot.
      const slots = matches.filter(function (pl) {
        return String(pl.class()) === 'userPlaylist' && !pl.smart() &&
          String(pl.specialKind()).toLowerCase() === 'none';
      });
      if (slots.length === 0) return JSON.stringify({ notEditable: true });
      if (slots.length !== 1) return JSON.stringify({ ambiguousPreview: true });
      const pl = slots[0];
      const ids = pl.tracks.length > 0 ? pl.tracks.persistentID() : [];
      if (JSON.stringify(ids) !== JSON.stringify(args.expectedTrackIds)) {
        return JSON.stringify({ orderDrifted: true });
      }
      const persistentId = pl.persistentID();
      Music.reveal(pl);
      Music.activate();
      return JSON.stringify({ persistentId: persistentId, trackCount: ids.length });
    `,
  );
}
