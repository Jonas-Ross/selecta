import type { PlaylistWriteResult } from './bridge.js';
import type { NoteRow } from './cache.js';
import type { SelectaError } from './errors.js';

export type CreatePlaylistInput = {
  name: string;
  description?: string;
  note?: string;
} & (
  | { trackIds: string[]; sourcePlaylistId?: never }
  | { sourcePlaylistId: string; trackIds?: never }
);

export type CreationObservation = {
  playlist: PlaylistWriteResult;
  name: string;
  expectedTrackIds: string[];
  source?: {
    playlistId: string;
    name: string;
    trackIds: string[];
    requestedId: string;
    cachedId: string;
  };
};

export type CreationOutcome =
  | { status: 'rejected_before_write'; error: SelectaError }
  | { status: 'write_uncertain'; error: SelectaError }
  | { status: 'observed_success'; observed: CreationObservation; note?: NoteRow }
  | { status: 'persistence_failed'; observed: CreationObservation; error: SelectaError };
