import type { CreationOutcome } from '../types/playlist_creation.js';
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

export type CreationFailureResponse = SelectaError & { lock_path?: string };
export type CommittedCreationCleanupResponse = CreatePlaylistOutput &
  CreationFailureResponse & {
    error: 'operation_cleanup_failed';
    creation_committed: true;
  };
export type CreatePlaylistResponse =
  | CreatePlaylistOutput
  | CreationFailureResponse
  | CommittedCreationCleanupResponse;

/** Wire projection shared by the direct and draft-save adapters. */
export function creationResponse(outcome: CreationOutcome): CreatePlaylistResponse {
  if (outcome.status !== 'observed_success' && outcome.status !== 'committed_cleanup_failed') {
    return { ...outcome.error, ...(outcome.lockPath ? { lock_path: outcome.lockPath } : {}) };
  }

  const { playlist, name, expectedTrackIds, source } = outcome.observed;

  return {
    ...(outcome.status === 'committed_cleanup_failed'
      ? {
          ...outcome.error,
          creation_committed: true,
          ...(outcome.lockPath ? { lock_path: outcome.lockPath } : {}),
        }
      : {}),
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
