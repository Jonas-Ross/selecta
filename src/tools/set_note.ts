// set_note — persist the model's own annotation on a track or playlist so a
// judgment formed while building one playlist survives into the next session.
// Cache-only: nothing is written to Music.app. Selecta hands the note back
// verbatim on every read surface and never reads it itself.

import { z } from 'zod';
import type { NoteSubject } from '../types/cache.js';
import type { SelectaError } from '../types/errors.js';
import {
  NOTE_MAX_LENGTH,
  apiNoteFromRow,
  missingTrackIdsError,
  parseInput,
  resolvePlaylist,
  toErrorEnvelope,
  type ApiNote,
  type ToolDeps,
} from './common.js';

export const setNoteInputShape = {
  subject: z.enum(['track', 'playlist']).describe('What the ID names.'),
  id: z
    .string()
    .min(1)
    .describe(
      'Track persistent ID (from search/get_track_context) or playlist ID (from list_playlists).',
    ),
  body: z
    .string()
    .max(NOTE_MAX_LENGTH)
    .describe(
      `The note, free text, up to ${NOTE_MAX_LENGTH} characters; replaces any existing note on this subject. Empty or whitespace-only clears the note.`,
    ),
};

const SetNoteInput = z.strictObject(setNoteInputShape);

export type SetNoteOutput =
  | { subject: NoteSubject; id: string; note: ApiNote }
  | { subject: NoteSubject; id: string; cleared: true };

export const SET_NOTE_DESCRIPTION = `Save your own note on a track or playlist so it survives this session — verbatim model memory, one note per subject ("great opener", "too abrasive for dinner sets", "use this version, not the remaster", or playlist-level feedback like "user approved the arc; preferred the plain name over the poetic working title"). Writing replaces the previous note wholesale, so fold in what you want to keep; an empty body clears it. Notes come back unchanged as a note field ({body, created_at, updated_at}) on search results, get_track_context, inspect_tracklist, list_playlists, and preview_playlist — Selecta never filters, sorts, or matches on them; what they mean is yours to decide. Cache-only: nothing is written to Music.app, and notes survive refresh_library and iCloud playlist rekeys. Fails with track_not_found / playlist_not_found (nothing stored) on an unknown ID — don't retry with the same input; re-resolve the ID via search or list_playlists, or refresh_library if the library changed. Returns the stored note with timestamps, or cleared: true.`;

export async function handleSetNote(
  raw: unknown,
  deps: ToolDeps,
): Promise<SetNoteOutput | SelectaError> {
  const parsed = parseInput(SetNoteInput, raw);
  if (!parsed.ok) return parsed.error;
  const { subject, body } = parsed.data;

  try {
    const cache = deps.cache();
    let id = parsed.data.id;
    if (subject === 'track') {
      const cacheMiss = missingTrackIdsError(cache, [id]);
      if (cacheMiss) return cacheMiss;
    } else {
      // Key playlist notes by canonical ID so reconciliation can follow rekeys.
      const resolved = resolvePlaylist(cache, id);
      if (!resolved.ok) return resolved.error;
      id = resolved.playlist.persistentId;
    }

    // Whitespace-only means clear; anything else is stored byte-for-byte —
    // indentation and line breaks are the model's own formatting.
    if (body.trim() === '') {
      cache.clearNote(subject, id);
      return { subject, id, cleared: true };
    }
    return { subject, id, note: apiNoteFromRow(cache.setNote(subject, id, body)) };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
