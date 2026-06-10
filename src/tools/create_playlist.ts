// create_playlist — materialize the final playlist in Music.app and patch the
// cache surgically (no full reread).

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import {
  missingTrackIdsError,
  toErrorEnvelope,
  validationError,
  type ToolDeps,
} from './common.js';

export const createPlaylistInputShape = {
  name: z.string().min(1).describe('Playlist name shown in Music.app — pick something evocative.'),
  track_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(500)
    .describe('Track persistent IDs in the exact order they should play.'),
  description: z.string().optional().describe('Optional playlist description.'),
};

const CreatePlaylistInput = z.strictObject(createPlaylistInputShape);

export type CreatePlaylistOutput = {
  playlist_id: string;
  name: string;
  track_count: number;
};

export const CREATE_PLAYLIST_DESCRIPTION = `Create a real playlist in the user's Music.app from owned track persistent IDs, preserving order. This writes to the user's library — only call once the user has approved a final tracklist (use preview_playlist for auditioning). Fails with track_not_found (nothing is created) if any ID is unknown; re-resolve IDs via search, or refresh_library if the cache is stale. Duplicate names are allowed by Music.app, so reuse of an existing name creates a second playlist rather than editing the first. The returned playlist_id may be reassigned by iCloud sync later — re-resolve via list_playlists if you need it in a much later turn.`;

export async function handleCreatePlaylist(
  raw: unknown,
  deps: ToolDeps,
): Promise<CreatePlaylistOutput | SelectaError> {
  const parsed = CreatePlaylistInput.safeParse(raw);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const { name, track_ids, description } = parsed.data;

  try {
    const cacheMiss = missingTrackIdsError(deps.cache(), track_ids);
    if (cacheMiss) return cacheMiss;

    const result = await deps.bridge.createPlaylist({ name, trackIds: track_ids, description });
    deps.cache().upsertPlaylistAfterWrite(result, name, track_ids);
    return { playlist_id: result.persistentId, name, track_count: result.trackCount };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
