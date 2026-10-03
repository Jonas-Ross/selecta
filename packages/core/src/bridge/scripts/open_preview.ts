import { PREVIEW_PLAYLIST_NAME } from '../../operations/playlist.js';
import { PREVIEW_SLOT } from './preview_slot.js';
import { wrapJxaScript } from './wrap.js';

/** Reveal the reserved slot only when its live sequence matches the caller's draft. */
export function buildOpenPreviewScript(input: { expectedTrackIds: string[] }): string {
  return wrapJxaScript(
    { ...input, name: PREVIEW_PLAYLIST_NAME },
    `${PREVIEW_SLOT}
      const persistentId = pl.persistentID();
      Music.reveal(pl);
      Music.activate();
      return JSON.stringify({ persistentId: persistentId, trackCount: ids.length });
    `,
  );
}
