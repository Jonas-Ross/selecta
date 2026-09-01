// Ordered-draft inspection: real in-memory cache over a dedicated fixture,
// bridge fully mocked, and the suite-wide network guard still in force.

import { describe, expect, it, vi } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import {
  handleInspectTracklist,
  orderedTrackIdsFingerprint,
  type InspectTracklistOutput,
} from '../src/tools/inspect_tracklist.js';
import type { ToolDeps } from '../src/tools/common.js';
import type { LibrarySnapshot, RawTrack } from '../src/types/bridge.js';
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

function makeLargeDraft(): { deps: ToolDeps; trackIds: string[] } {
  const tracks: RawTrack[] = Array.from({ length: 500 }, (_, index) => ({
    persistentId: `T-LARGE-${String(index + 1).padStart(4, '0')}`,
    title: `Track ${String(index + 1).padStart(3, '0')}`,
    artist: `Artist ${String((index % 80) + 1).padStart(2, '0')}`,
    albumArtist: `Artist ${String((index % 80) + 1).padStart(2, '0')}`,
    album: `Album ${String(Math.floor(index / 10) + 1).padStart(2, '0')}`,
    durationSeconds: 180 + (index % 120),
    bpm: index % 4 === 0 ? undefined : 88 + (index % 70),
    playCount: index % 100,
    skipCount: index % 6,
    rating: index % 9 === 0 ? 80 : undefined,
    loved: index % 17 === 0,
    locationKind: index % 3 === 0 ? 'local' : 'cloud',
  }));
  const features: AudioFeaturesRow[] = tracks
    .filter((_, index) => index % 3 !== 0)
    .map((track, index) => ({
      trackPersistentId: track.persistentId,
      bpm: null,
      musicalKey: index % 5 === 0 ? null : ['C major', 'D minor', 'F# minor'][index % 3]!,
      danceability: index % 7 === 0 ? null : 0.35 + (index % 50) / 100,
      sources: { musicalKey: 'acousticbrainz', danceability: 'acousticbrainz' },
      mbRecordingMbid: `mbid-large-${index}`,
      deezerTrackId: null,
      status: 'ok',
      fetchedAt: '2026-08-02T00:00:00.000Z',
    }));
  const cache = SelectaCache.open(':memory:');
  cache.refreshFromSnapshot(
    { capturedAt: '2026-08-01T12:00:00.000Z', tracks, playlists: [] },
    { durationMs: 1 },
  );
  cache.saveAudioFeatures(features);
  return {
    deps: { cache: () => cache, bridge: makeBridge() },
    trackIds: tracks.map((track) => track.persistentId),
  };
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
      title: 'Été Noir',
      artist: 'Beyoncé',
      album: 'First Light',
      duration_seconds: 210,
      bpm: 118.4,
      musical_key: 'F# minor',
      danceability: 0.73,
      signal: { play_count: 12, skip_count: 1, rating: 4, loved: true },
    });
    expect(JSON.parse(JSON.stringify(out.tracks[2]!.signal))).toEqual({
      play_count: 4,
      skip_count: 3,
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
      { artist: 'Beyoncé', count: 3 },
      { artist: 'Mira', count: 1 },
    ]);
    expect(out.unknown_artist_count).toBe(1);
    expect(out.feature_coverage).toEqual({
      bpm: { present_count: 3, missing_count: 2 },
      musical_key: { present_count: 3, missing_count: 2 },
      danceability: { present_count: 3, missing_count: 2 },
    });
    expect(out.feature_gaps).toEqual([
      {
        missing: ['musical_key', 'danceability'],
        track_ids: ['T-TURN'],
      },
      { missing: ['bpm'], track_ids: ['T-DREAM-B'] },
      {
        missing: ['bpm', 'musical_key', 'danceability'],
        track_ids: ['T-BARE'],
      },
    ]);
  });

  it('reports repeated IDs separately from distinct owned copies of one song', async () => {
    const out = await inspect();
    expect(out.duplicate_ids).toEqual([
      { persistent_id: 'T-DREAM-A', count: 2, positions: [0, 3] },
    ]);
    expect(out.duplicate_owned_copies).toEqual([
      {
        title: 'Été Noir',
        artist: 'Beyoncé',
        copies: [
          { persistent_id: 'T-DREAM-A', positions: [0, 3] },
          { persistent_id: 'T-DREAM-B', positions: [2] },
        ],
      },
    ]);
  });

  it('fingerprints the UTF-8 JSON ID array stably, including order and ID boundaries', async () => {
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
    expect(orderedTrackIdsFingerprint(['ab', 'c'])).not.toBe(
      orderedTrackIdsFingerprint(['a', 'bc']),
    );
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

  it('stays below 150 KB for 500 distinct, realistically populated tracks', async () => {
    const { deps, trackIds } = makeLargeDraft();
    const out = (await handleInspectTracklist(
      { track_ids: trackIds },
      deps,
    )) as InspectTracklistOutput;
    expect(out.track_count).toBe(500);
    expect(new Set(out.tracks.map((track) => track.persistent_id)).size).toBe(500);
    expect(out.tracks[0]!.persistent_id).toBe('T-LARGE-0001');
    expect(out.tracks.at(-1)!.persistent_id).toBe('T-LARGE-0500');
    expect(JSON.stringify(out).length).toBeLessThan(150_000);
  });
});
