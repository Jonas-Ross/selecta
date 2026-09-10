import { createPlaylist } from '../operations/create_playlist.js';
// create_playlist — materialize the final playlist in Music.app and patch the
// cache surgically (no full reread).

import { z } from 'zod';
import { PLAYLIST_WRITE_TRACK_LIMIT } from '../types/bridge.js';
import type { SelectaError } from '../types/errors.js';
import { NOTE_MAX_LENGTH } from '../domain/track_projections.js';
import { creationResponse, type CreatePlaylistOutput } from '../domain/playlist_creation.js';
import { parseInput } from './errors.js';
import type { ToolDeps } from './deps.js';
import { PREVIEW_PLAYLIST_NAME } from './preview_playlist.js';

export const createPlaylistInputShape = {
  name: z.string().min(1).describe('Playlist name shown in Music.app — pick something evocative.'),
  track_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(PLAYLIST_WRITE_TRACK_LIMIT)
    .optional()
    .describe(
      'Track persistent IDs in the exact order they should play. Mutually exclusive with source_playlist_id.',
    ),
  source_playlist_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Non-empty plain user playlist to clone from its current live Music.app order (max ${PLAYLIST_WRITE_TRACK_LIMIT} entries). Mutually exclusive with track_ids.`,
    ),
  description: z.string().optional().describe('Optional playlist description.'),
  note: z
    .string()
    .max(NOTE_MAX_LENGTH)
    .refine((body) => body.trim() !== '', 'note must not be blank')
    .optional()
    .describe(
      'Optional note to store on the new playlist (same as a set_note call right after creation): verbatim memory for later sessions, e.g. what the user approved and why the name won. Cache-only, never shown in Music.app.',
    ),
};

const CreatePlaylistInput = z
  .strictObject(createPlaylistInputShape)
  .refine((input) => (input.track_ids === undefined) !== (input.source_playlist_id === undefined), {
    path: ['track_ids'],
    message: 'Provide exactly one of track_ids or source_playlist_id.',
  });

export type { CreatePlaylistOutput } from '../domain/playlist_creation.js';

export const CREATE_PLAYLIST_DESCRIPTION = `Create a real playlist in the user's Music.app, preserving order. Provide exactly one source: ordered track_ids, or source_playlist_id to clone an approved preview/existing playlist from its current live order without resending IDs. This writes to the user's library — only call once the user has approved the final tracklist (use preview_playlist for auditioning). Clone sources must be non-empty plain user playlists with at most ${PLAYLIST_WRITE_TRACK_LIMIT} entries; generated, smart, subscription, special, and folder playlists fail with playlist_not_editable before creation because their external curation is not stable user signal. A clone reads and resolves every live source entry before creating anything. Clone-path track_not_found means the live source contains unavailable/dangling entries: remove or replace those entries in the source before trying again; refresh_library cannot repair the live source, and do not retry it unchanged. Explicit track_ids still fail before creation if an ID is unknown; re-resolve those IDs via search, or refresh_library if that cache is stale. A preview_playlist playlist_id keeps working after iCloud rekeys a first-ever "${PREVIEW_PLAYLIST_NAME}": only that reserved slot is re-resolved by name when its ID is gone live (source.rekeyed_from reports it); every other source is a strict live-ID lookup. Preview-slot playlist_not_found means no "${PREVIEW_PLAYLIST_NAME}" exists any more — call preview_playlist again rather than retrying; a validation_error naming several copies means the slot is ambiguous — run refresh_library to inspect the copies and ask the user which one to keep; never guess. Duplicate names are allowed by Music.app, so reuse of an existing name creates a second playlist rather than editing the first. The returned playlist_id may be reassigned by iCloud sync later — re-resolve via list_playlists if you need it in a much later turn. iCloud sync occasionally duplicates a just-created playlist (same tracks, different ID) within ~3 minutes — the create did not fail or run twice, so never retry; running refresh_library a few minutes after creation reports ambiguous copies in sync_reconciliation.ambiguous without deleting anything as long as it runs within an hour of the create. order_matches_request: false means the observed destination differs from the requested list or live source; the cache contains the observed destination. partial_write on an error preserves a target ID and any validated observed order after population, readback, or local persistence failure. Local creation state is committed atomically after Music.app returns; persistence failure rolls it back. Inspect the target and refresh the cache; do not repeat creation. An error without a partial_write receipt can still have an uncertain external outcome. Pass note to record playlist-level memory (the user's verdict on the arc, the name they preferred) at creation — it follows the playlist through later iCloud rekeys and comes back on list_playlists.`;

export async function handleCreatePlaylist(
  raw: unknown,
  deps: ToolDeps,
): Promise<CreatePlaylistOutput | SelectaError> {
  const parsed = parseInput(CreatePlaylistInput, raw);

  if (!parsed.ok) return parsed.error;

  const { name, track_ids, source_playlist_id, description, note } = parsed.data;

  return creationResponse(
    await createPlaylist(
      {
        name,
        description,
        note,
        ...(track_ids !== undefined
          ? { trackIds: track_ids }
          : { sourcePlaylistId: source_playlist_id! }),
      },
      deps,
    ),
  );
}
