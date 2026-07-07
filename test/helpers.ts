// Shared test scaffolding. The all-rejecting Bridge mock lives here once —
// adding a Bridge method means one edit in this file, not one per test file
// (adding the #15 edit methods touched four copies before this existed).

import { expect, vi } from 'vitest';
import type { Bridge, LibrarySnapshot } from '../src/types/bridge.js';
import type { AudioFeaturesRow } from '../src/types/cache.js';
import type { SelectaError } from '../src/types/errors.js';

/** The snapshot with per-track play/skip counters moved — the play-history stimulus. */
export function bumpedSnapshot(
  snapshot: LibrarySnapshot,
  deltas: Record<string, { plays?: number; skips?: number }>,
): LibrarySnapshot {
  return {
    ...snapshot,
    tracks: snapshot.tracks.map((t) => {
      const d = deltas[t.persistentId];
      if (!d) return t;
      return {
        ...t,
        playCount: (t.playCount ?? 0) + (d.plays ?? 0),
        skipCount: (t.skipCount ?? 0) + (d.skips ?? 0),
      };
    }),
  };
}

export function makeBridge(overrides: Partial<Bridge> = {}): Bridge {
  return {
    readPlaylist: vi.fn().mockRejectedValue(new Error('not used')),
    readLibrary: vi.fn().mockRejectedValue(new Error('not used')),
    createPlaylist: vi.fn().mockRejectedValue(new Error('not used')),
    replacePlaylist: vi.fn().mockRejectedValue(new Error('not used')),
    deletePlaylistById: vi.fn().mockRejectedValue(new Error('not used')),
    addPlaylistTracks: vi.fn().mockRejectedValue(new Error('not used')),
    removePlaylistTracks: vi.fn().mockRejectedValue(new Error('not used')),
    reorderPlaylistTracks: vi.fn().mockRejectedValue(new Error('not used')),
    setTrackLoved: vi.fn().mockRejectedValue(new Error('not used')),
    setTrackRating: vi.fn().mockRejectedValue(new Error('not used')),
    ...overrides,
  };
}

export function asError(result: object): SelectaError {
  expect(result).toHaveProperty('error');
  return result as SelectaError;
}

/** A fully-populated audio_features row for T-TEARDROP; override to taste. */
export function featuresRow(overrides: Partial<AudioFeaturesRow> = {}): AudioFeaturesRow {
  return {
    trackPersistentId: 'T-TEARDROP',
    bpm: 78.42,
    musicalKey: 'A minor',
    danceability: 0.618,
    sources: { bpm: 'deezer', musicalKey: 'acousticbrainz', danceability: 'acousticbrainz' },
    mbRecordingMbid: 'mbid-teardrop',
    deezerTrackId: 3129407,
    status: 'ok',
    fetchedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}
