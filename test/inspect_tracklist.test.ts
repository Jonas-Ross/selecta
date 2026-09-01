// Ordered-draft inspection: real in-memory cache over a dedicated fixture,
// bridge fully mocked, and the suite-wide network guard still in force.

import { describe, expect, it, vi } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import {
  handleInspectTracklist,
  type InspectTracklistOutput,
} from '../src/tools/inspect_tracklist.js';
import type { ToolDeps } from '../src/tools/common.js';
import type { LibrarySnapshot } from '../src/types/bridge.js';
import type { AudioFeaturesRow } from '../src/types/cache.js';
import { asError, makeBridge } from './helpers.js';
import fixture from './fixtures/inspect-tracklist.json' with { type: 'json' };

const inspectFixture = fixture as {
  snapshot: LibrarySnapshot;
  audioFeatures: AudioFeaturesRow[];
  draftTrackIds: string[];
};

function makeDeps(): ToolDeps {
  const cache = SelectaCache.open(':memory:');
  cache.refreshFromSnapshot(inspectFixture.snapshot, { durationMs: 1 });
  cache.saveAudioFeatures(inspectFixture.audioFeatures);
  return { cache: () => cache, bridge: makeBridge() };
}

async function inspect(deps = makeDeps()): Promise<InspectTracklistOutput> {
  return (await handleInspectTracklist(
    { track_ids: inspectFixture.draftTrackIds },
    deps,
  )) as InspectTracklistOutput;
}

describe('inspect_tracklist', () => {
  it('preserves supplied order and returns only draft-relevant track facts', async () => {
    const out = await inspect();
    expect(out.tracks.map((track) => track.persistent_id)).toEqual(inspectFixture.draftTrackIds);
    expect(out.tracks[0]).toEqual({
      persistent_id: 'T-DREAM-A',
      title: 'Night Drive',
      artist: 'Neon Coast',
      album: 'First Light',
      duration_seconds: 210,
      bpm: 118.4,
      musical_key: 'F# minor',
      danceability: 0.73,
      signal: { play_count: 12, skip_count: 1, rating: 4, loved: true },
    });
    expect(out.tracks[2]!.signal).toEqual({
      play_count: 4,
      skip_count: 3,
      rating: null,
      loved: false,
    });
    expect(out.tracks[0]).not.toHaveProperty('genre');
    expect(out.tracks[0]).not.toHaveProperty('year');
    expect(out.tracks[0]).not.toHaveProperty('location_kind');
    expect(out.tracks[0]!.signal).not.toHaveProperty('last_played');
    expect(out).not.toHaveProperty('playlists');
  });

  it('computes runtime, artist occurrences, and every feature aggregate from the fixture', async () => {
    const out = await inspect();
    expect(out.track_count).toBe(5);
    expect(out.runtime).toEqual({
      known_seconds: 817,
      missing_count: 1,
      missing_track_ids: ['T-BARE'],
    });
    expect(out.artist_counts).toEqual([
      { artist: 'Neon Coast', count: 3 },
      { artist: 'Mira', count: 1 },
    ]);
    expect(out.unknown_artist_count).toBe(1);
    expect(out.feature_coverage).toEqual({
      bpm: {
        present_count: 3,
        missing_count: 2,
        missing_track_ids: ['T-DREAM-B', 'T-BARE'],
      },
      musical_key: {
        present_count: 3,
        missing_count: 2,
        missing_track_ids: ['T-TURN', 'T-BARE'],
      },
      danceability: {
        present_count: 3,
        missing_count: 2,
        missing_track_ids: ['T-TURN', 'T-BARE'],
      },
    });
  });

  it('reports repeated IDs separately from distinct owned copies of one song', async () => {
    const out = await inspect();
    expect(out.duplicate_ids).toEqual([
      { persistent_id: 'T-DREAM-A', count: 2, positions: [0, 3] },
    ]);
    expect(out.duplicate_owned_copies).toEqual([
      {
        title: 'Night Drive',
        artist: 'Neon Coast',
        copies: [
          { persistent_id: 'T-DREAM-A', positions: [0, 3] },
          { persistent_id: 'T-DREAM-B', positions: [2] },
        ],
      },
    ]);
  });

  it('fingerprints the ordered ID list stably and changes when order changes', async () => {
    const deps = makeDeps();
    const out = await inspect(deps);
    expect(out.fingerprint).toBe(
      'sha256:e4ac5d46e0944e54cd57d9780a5ed9b0ac7c7d569a49e1c9b6dfd76f6894bbd3',
    );
    const reordered = (await handleInspectTracklist(
      { track_ids: [...inspectFixture.draftTrackIds].reverse() },
      deps,
    )) as InspectTracklistOutput;
    expect(reordered.fingerprint).not.toBe(out.fingerprint);
  });

  it('fails the whole inspection on unknown IDs before returning any draft facts', async () => {
    const deps = makeDeps();
    const result = await handleInspectTracklist(
      { track_ids: ['T-DREAM-A', 'T-NOT-OWNED', 'T-TURN'] },
      deps,
    );
    const err = asError(result);
    expect(err.error).toBe('track_not_found');
    expect(err.hint).toContain('T-NOT-OWNED');
    expect(result).not.toHaveProperty('tracks');
    expect(result).not.toHaveProperty('fingerprint');
  });

  it('uses only the cache: no Music.app bridge method or network fetch runs', async () => {
    const deps = makeDeps();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await inspect(deps);
    for (const method of Object.values(deps.bridge)) expect(method).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('stays compact at the 500-track input limit', async () => {
    const deps = makeDeps();
    const out = (await handleInspectTracklist(
      { track_ids: Array.from({ length: 500 }, () => 'T-DREAM-A') },
      deps,
    )) as InspectTracklistOutput;
    expect(out.track_count).toBe(500);
    expect(JSON.stringify(out).length).toBeLessThan(150_000);
  });
});
