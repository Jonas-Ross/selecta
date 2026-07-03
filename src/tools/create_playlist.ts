// create_playlist — materialize the final playlist in Music.app and patch the
// cache surgically (no full reread).

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import {
  missingTrackIdsError,
  parseInput,
  toErrorEnvelope,
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

export const CREATE_PLAYLIST_DESCRIPTION = `Create a real playlist in the user's Music.app from owned track persistent IDs, preserving order. This writes to the user's library — only call once the user has approved a final tracklist (use preview_playlist for auditioning). Fails with track_not_found (nothing is created) if any ID is unknown; re-resolve IDs via search, or refresh_library if the cache is stale. Duplicate names are allowed by Music.app, so reuse of an existing name creates a second playlist rather than editing the first. The returned playlist_id may be reassigned by iCloud sync later — re-resolve via list_playlists if you need it in a much later turn. iCloud sync occasionally duplicates a just-created playlist (same tracks, different ID) within ~3 minutes — the create did not fail or run twice, so never retry; running refresh_library a few minutes after creation detects and removes the echo copy automatically (reported in its sync_reconciliation field) as long as it runs within an hour of the create.`;

export async function handleCreatePlaylist(
  raw: unknown,
  deps: ToolDeps,
): Promise<CreatePlaylistOutput | SelectaError> {
  const parsed = parseInput(CreatePlaylistInput, raw);
  if (!parsed.ok) return parsed.error;
  const { name, track_ids, description } = parsed.data;

  try {
    const cache = deps.cache();
    const cacheMiss = missingTrackIdsError(cache, track_ids);
    if (cacheMiss) return cacheMiss;

    const result = await deps.bridge.createPlaylist({ name, trackIds: track_ids, description });
    cache.upsertPlaylistAfterWrite(result, name, track_ids);
    // Creation receipt: lets the next refresh recognize iCloud rekeys and echo
    // duplicates of this exact playlist (docs/music-app.md, iCloud sync).
    cache.recordPlaylistCreation(result.persistentId, name, track_ids);
    return { playlist_id: result.persistentId, name, track_count: result.trackCount };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
