// create_playlist — materialize the final playlist in Music.app and patch the
// cache surgically (no full reread).

import { z } from 'zod';
import { PLAYLIST_WRITE_TRACK_LIMIT } from '../types/bridge.js';
import type { SelectaError } from '../types/errors.js';
import type { SelectaCache } from '../cache/index.js';
import {
  NOTE_MAX_LENGTH,
  apiNoteFromRow,
  missingTrackIdsError,
  parseInput,
  resolvePlaylist,
  toErrorEnvelope,
  validationError,
  type ApiNote,
  type ToolDeps,
} from './common.js';

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

const CreatePlaylistInput = z.strictObject(createPlaylistInputShape).refine(
  (input) => (input.track_ids === undefined) !== (input.source_playlist_id === undefined),
  {
    path: ['track_ids'],
    message: 'Provide exactly one of track_ids or source_playlist_id.',
  },
);

export type CreatePlaylistOutput = {
  playlist_id: string;
  name: string;
  track_count: number;
  note?: ApiNote;
  source?: {
    playlist_id: string;
    name: string;
    track_count: number;
  };
};

export const CREATE_PLAYLIST_DESCRIPTION = `Create a real playlist in the user's Music.app, preserving order. Provide exactly one source: ordered track_ids, or source_playlist_id to clone an approved preview/existing playlist from its current live order without resending IDs. This writes to the user's library — only call once the user has approved the final tracklist (use preview_playlist for auditioning). Clone sources must be non-empty plain user playlists with at most ${PLAYLIST_WRITE_TRACK_LIMIT} entries; generated, smart, subscription, special, and folder playlists fail with playlist_not_editable before creation because their external curation is not stable user signal. A clone reads and resolves every live source entry before creating anything. Clone-path track_not_found means the live source contains unavailable/dangling entries: remove or replace those entries in the source before trying again; refresh_library cannot repair the live source, and do not retry it unchanged. Explicit track_ids still fail before creation if an ID is unknown; re-resolve those IDs via search, or refresh_library if that cache is stale. Duplicate names are allowed by Music.app, so reuse of an existing name creates a second playlist rather than editing the first. The returned playlist_id may be reassigned by iCloud sync later — re-resolve via list_playlists if you need it in a much later turn. iCloud sync occasionally duplicates a just-created playlist (same tracks, different ID) within ~3 minutes — the create did not fail or run twice, so never retry; running refresh_library a few minutes after creation detects and removes the echo copy automatically (reported in its sync_reconciliation field) as long as it runs within an hour of the create. Pass note to record playlist-level memory (the user's verdict on the arc, the name they preferred) at creation — it follows the playlist through later iCloud rekeys and comes back on list_playlists.`;

// The creation-time note lands on the ID Music.app just returned — the same
// ID the receipt names, so reconciliation carries it through a later rekey.
function storeNote(
  cache: SelectaCache,
  playlistId: string,
  note: string | undefined,
): ApiNote | undefined {
  if (note === undefined) return undefined;
  return apiNoteFromRow(cache.setNote('playlist', playlistId, note));
}

export async function handleCreatePlaylist(
  raw: unknown,
  deps: ToolDeps,
): Promise<CreatePlaylistOutput | SelectaError> {
  const parsed = parseInput(CreatePlaylistInput, raw);
  if (!parsed.ok) return parsed.error;
  const { name, track_ids, source_playlist_id, description, note } = parsed.data;

  try {
    const cache = deps.cache();
    if (track_ids !== undefined) {
      const cacheMiss = missingTrackIdsError(cache, track_ids);
      if (cacheMiss) return cacheMiss;

      const result = await deps.bridge.createPlaylist({ name, trackIds: track_ids, description });
      cache.upsertPlaylistAfterWrite(result, name, track_ids);
      cache.recordPlaylistCreation(result.persistentId, name, track_ids);
      return {
        playlist_id: result.persistentId,
        name,
        track_count: result.trackCount,
        note: storeNote(cache, result.persistentId, note),
      };
    }

    const source = resolvePlaylist(cache, source_playlist_id!);
    if (!source.ok) return source.error;
    if (source.playlist.kind !== 'user') {
      return {
        error: 'playlist_not_editable',
        hint: `"${source.playlist.name}" is a ${source.playlist.kind} playlist. Clone sources must be plain user playlists so externally changing curation does not become user co-occurrence signal.`,
      };
    }
    if (source.playlist.trackCount < 1) {
      return validationError(
        `Source playlist "${source.playlist.name}" is empty. Clone sources must contain 1-${PLAYLIST_WRITE_TRACK_LIMIT} entries.`,
      );
    }
    if (source.playlist.trackCount > PLAYLIST_WRITE_TRACK_LIMIT) {
      return validationError(
        `Source playlist "${source.playlist.name}" has ${source.playlist.trackCount} cached entries; the maximum is ${PLAYLIST_WRITE_TRACK_LIMIT}.`,
      );
    }

    const result = await deps.bridge.clonePlaylist({
      name,
      sourcePlaylistId: source.playlist.persistentId,
      description,
    });
    const trackIds = result.sourceTrackPersistentIds;
    cache.upsertPlaylistAfterWrite(result, name, trackIds);
    // Creation receipt: lets the next refresh recognize iCloud rekeys and echo
    // duplicates of this exact playlist (docs/music-app.md, iCloud sync).
    cache.recordPlaylistCreation(result.persistentId, name, trackIds);
    return {
      playlist_id: result.persistentId,
      name,
      track_count: result.trackCount,
      note: storeNote(cache, result.persistentId, note),
      source: {
        playlist_id: result.sourcePersistentId,
        name: result.sourceName,
        track_count: trackIds.length,
      },
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
