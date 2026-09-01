// Realistic broad-discovery payload checks. A dense hand-made playlist graph
// makes repeated source names visible without inventing oversized track text.

import { describe, expect, it } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import {
  handleGetTrackContext,
  type CompactMultiSeedContextOutput,
  type CompactTrackContextOutput,
  type MultiSeedContextOutput,
  type TrackContextOutput,
} from '../src/tools/get_track_context.js';
import {
  handleSearch,
  type CompactSearchOutput,
  type SearchOutput,
} from '../src/tools/search.js';
import type { ToolDeps } from '../src/tools/common.js';
import type { LibrarySnapshot, RawTrack } from '../src/types/bridge.js';
import { makeBridge } from './helpers.js';

const PLAYLISTS = [
  ['P-AFTER-MIDNIGHT', 'Late Night Electronic Deep Cuts'],
  ['P-LONG-DRIVE', 'Long-Drive Favorites'],
  ['P-OWNED-GEMS', 'Owned Library Gems'],
  ['P-HEADPHONES', 'Headphones After Dark'],
  ['P-SUNDAY-RESET', 'Sunday Reset Rotation'],
  ['P-BASEMENT-FINDS', 'Basement Finds and B-Sides'],
] as const;

const CANDIDATE_COUNT = 60;

function track(persistentId: string, index: number): RawTrack {
  return {
    persistentId,
    title: `Discovery Track ${index + 1}`,
    artist: `Library Artist ${(index % 12) + 1}`,
    albumArtist: `Library Artist ${(index % 12) + 1}`,
    album: `Owned Album ${(index % 20) + 1}`,
    genre: ['Electronic', 'Trip-Hop', 'Ambient', 'Indie'][index % 4],
    year: 1995 + (index % 30),
    durationSeconds: 180 + (index % 240),
    bpm: index % 2 === 0 ? 72 + (index % 70) : undefined,
    dateAdded: `2025-${String((index % 12) + 1).padStart(2, '0')}-15T12:00:00.000Z`,
    lastPlayed:
      index % 3 === 0
        ? `2026-08-${String((index % 28) + 1).padStart(2, '0')}T20:00:00.000Z`
        : undefined,
    playCount: 5 + index,
    skipCount: index % 4,
    rating: index % 5 === 0 ? 100 : undefined,
    loved: index % 7 === 0,
    locationKind: index % 2 === 0 ? 'local' : 'cloud',
  };
}

function discoverySnapshot(): LibrarySnapshot {
  const seedIds = ['T-SEED-ONE', 'T-SEED-TWO'];
  const candidateIds = Array.from(
    { length: CANDIDATE_COUNT },
    (_, index) => `T-CANDIDATE-${String(index + 1).padStart(3, '0')}`,
  );
  const memberships = PLAYLISTS.map(() => [...seedIds]);
  for (let index = 0; index < candidateIds.length; index++) {
    const playlistIndexes = [index % 6, (index + 1) % 6, (index + 3) % 6];
    for (const playlistIndex of playlistIndexes) memberships[playlistIndex]!.push(candidateIds[index]!);
  }
  const seedOne = {
    ...track(seedIds[0]!, 100),
    artist: 'Seed Artist One',
    albumArtist: 'Seed Artist One',
  };
  const seedTwo = {
    ...track(seedIds[1]!, 101),
    artist: 'Seed Artist Two',
    albumArtist: 'Seed Artist Two',
  };

  return {
    capturedAt: '2026-08-31T12:00:00.000Z',
    tracks: [seedOne, seedTwo, ...candidateIds.map(track)],
    playlists: PLAYLISTS.map(([persistentId, name], index) => ({
      persistentId,
      name,
      kind: 'user',
      trackPersistentIds: memberships[index]!,
    })),
  };
}

function deps(): ToolDeps {
  const cache = SelectaCache.open(':memory:');
  cache.refreshFromSnapshot(discoverySnapshot(), { durationMs: 1 });
  return { cache: () => cache, bridge: makeBridge() };
}

function bytes(value: object): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function expectLegendIsComplete(
  compact: CompactTrackContextOutput | CompactMultiSeedContextOutput,
): void {
  expect(compact.playlist_legend).toHaveLength(PLAYLISTS.length);
  const expectedById = new Map(PLAYLISTS);
  for (const playlist of compact.playlist_legend) {
    expect(playlist.name).toBe(expectedById.get(playlist.id));
  }
  for (const candidate of compact.co_occurring_tracks) {
    expect(candidate.playlist_refs).toHaveLength(3);
    for (const ref of candidate.playlist_refs) {
      expect(compact.playlist_legend[ref]).toBeDefined();
    }
  }
}

describe('compact serialized size', () => {
  it('removes repeated track keys from broad search rows', async () => {
    const toolDeps = deps();
    const full = (await handleSearch({ limit: 100 }, toolDeps)) as SearchOutput;
    const compact = (await handleSearch(
      { limit: 100, compact: true },
      toolDeps,
    )) as CompactSearchOutput;

    expect(full.tracks).toHaveLength(CANDIDATE_COUNT + 2);
    expect(compact.tracks).toHaveLength(CANDIDATE_COUNT + 2);
    expect(compact.tracks.map(({ track }) => track[0])).toEqual(
      full.tracks.map(({ persistent_id }) => persistent_id),
    );
    expect(bytes(compact)).toBeLessThan(bytes(full) * 0.65);
  });

  it('deduplicates playlist facts across a broad single-seed result', async () => {
    const toolDeps = deps();
    const full = (await handleGetTrackContext(
      { track_id: 'T-SEED-ONE' },
      toolDeps,
    )) as TrackContextOutput;
    const compact = (await handleGetTrackContext(
      { track_id: 'T-SEED-ONE', compact: true },
      toolDeps,
    )) as CompactTrackContextOutput;

    expect(full.co_occurring_tracks).toHaveLength(50);
    expect(compact.co_occurring_tracks).toHaveLength(50);
    expectLegendIsComplete(compact);
    expect(bytes(compact)).toBeLessThan(bytes(full) * 0.6);
  });

  it('deduplicates the same playlist facts across multi-seed discovery', async () => {
    const toolDeps = deps();
    const full = (await handleGetTrackContext(
      { seed_ids: ['T-SEED-ONE', 'T-SEED-TWO'] },
      toolDeps,
    )) as MultiSeedContextOutput;
    const compact = (await handleGetTrackContext(
      { seed_ids: ['T-SEED-ONE', 'T-SEED-TWO'], compact: true },
      toolDeps,
    )) as CompactMultiSeedContextOutput;

    expect(full.co_occurring_tracks).toHaveLength(CANDIDATE_COUNT);
    expect(compact.co_occurring_tracks).toHaveLength(CANDIDATE_COUNT);
    expectLegendIsComplete(compact);
    expect(bytes(compact)).toBeLessThan(bytes(full) * 0.6);
  });
});
