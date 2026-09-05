import { withOperation } from '../operations/lock.js';
// preview_playlist — overwrite the single dedicated audition slot in Music.app.

import { z } from 'zod';
import { PLAYLIST_WRITE_TRACK_LIMIT } from '../types/bridge.js';
import type { SelectaError } from '../types/errors.js';
import {
  apiNoteFromRow,
  missingTrackIdsError,
  parseInput,
  toErrorEnvelope,
  type ApiNote,
  type ToolDeps,
} from './common.js';

import { PREVIEW_PLAYLIST_NAME } from '../operations/playlist.js';
export { PREVIEW_PLAYLIST_NAME };

export const previewPlaylistInputShape = {
  track_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(PLAYLIST_WRITE_TRACK_LIMIT)
    .describe('Track persistent IDs in the exact order they should play.'),
};

const PreviewPlaylistInput = z.strictObject(previewPlaylistInputShape);

export type PreviewPlaylistOutput = {
  playlist_id: string;
  track_count: number;
  note?: ApiNote;
};

export const PREVIEW_PLAYLIST_DESCRIPTION = `Overwrite the single "${PREVIEW_PLAYLIST_NAME}" playlist in Music.app with these tracks so the user can audition a draft before committing. The slot is reused on every call (stable playlist, contents replaced) — previous preview contents are discarded without warning. When the user approves, pass this result's playlist_id to create_playlist as source_playlist_id; it clones the current live preview order without resending track IDs. That playlist_id stays valid even if iCloud rekeys a first-ever slot while the user auditions — create_playlist re-resolves the slot by its reserved name. Same track ID rules as create_playlist: unknown IDs fail with track_not_found and nothing is written. iCloud sync occasionally twins the slot right after its first-ever creation — harmless and not a failed call; later previews keep overwriting one copy, and refresh_library reports ambiguous copies without deleting them; ask the user which copy to keep. Any set_note memory on the preview slot comes back as note.`;

export async function handlePreviewPlaylist(
  raw: unknown,
  deps: ToolDeps,
): Promise<PreviewPlaylistOutput | SelectaError> {
  const parsed = parseInput(PreviewPlaylistInput, raw);
  if (!parsed.ok) return parsed.error;
  const { track_ids } = parsed.data;

  try {
    const cache = deps.cache();
    return await withOperation(cache, 'music', async () => {
      const cacheMiss = missingTrackIdsError(cache, track_ids);
      if (cacheMiss) return cacheMiss;

      const result = await deps.bridge.replacePlaylist({
        name: PREVIEW_PLAYLIST_NAME,
        trackIds: track_ids,
      });
      cache.upsertPlaylistAfterWrite(result, PREVIEW_PLAYLIST_NAME, track_ids);
      // A first-ever slot is a fresh playlist, so iCloud may rekey it: the same
      // receipt create_playlist records keeps this playlist_id resolvable
      // (docs/music-app.md, iCloud sync). An overwrite created nothing.
      if (result.created) {
        cache.recordPlaylistCreation(result.persistentId, PREVIEW_PLAYLIST_NAME, track_ids);
      }
      return {
        playlist_id: result.persistentId,
        track_count: result.trackCount,
        note: apiNoteFromRow(cache.getNote('playlist', result.persistentId)),
      };
    });
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
