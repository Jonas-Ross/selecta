import type { CreationOutcome } from '../operations/create_playlist.js';
import type { SelectaError } from '../types/errors.js';
import { apiNoteFromRow, type ApiNote } from './track_projections.js';

export type CreatePlaylistOutput = {
  playlist_id: string;
  name: string;
  track_count: number;
  order_matches_request?: boolean;
  note?: ApiNote;
  source?: {
    playlist_id: string;
    name: string;
    track_count: number;
    // Present when the live source ID differs from source_playlist_id: iCloud
    // rekeyed the playlist and the receipt/cache alias was followed.
    rekeyed_from?: string;
  };
};

/** Wire projection shared by the direct and draft-save adapters. */
export function creationResponse(outcome: CreationOutcome): CreatePlaylistOutput | SelectaError {
  if (outcome.status !== 'observed_success') return outcome.error;

  const { playlist, name, expectedTrackIds, source } = outcome.observed;

  return {
    playlist_id: playlist.persistentId,
    name,
    track_count: playlist.trackCount,
    ...(JSON.stringify(playlist.trackPersistentIds) !== JSON.stringify(expectedTrackIds)
      ? { order_matches_request: false }
      : {}),
    ...(outcome.note ? { note: apiNoteFromRow(outcome.note) } : {}),
    ...(source
      ? {
          source: {
            playlist_id: source.playlistId,
            name: source.name,
            track_count: source.trackIds.length,
            ...(source.playlistId !== source.requestedId
              ? { rekeyed_from: source.requestedId }
              : {}),
          },
        }
      : {}),
  };
}
