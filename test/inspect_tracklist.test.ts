// Ordered-draft inspection: real in-memory cache over a dedicated fixture,
// bridge fully mocked, and the suite-wide network guard still in force.

import { describe, expect, it, vi } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import {
  handleInspectTracklist,
  type InspectTracklistOutput,
} from '../src/tools/inspect_tracklist.js';
import { orderedTrackIdsFingerprint } from '../src/domain/tracklist_inspection.js';
import type { ToolDeps } from '../src/tools/deps.js';
import type { LibrarySnapshot, RawTrack } from '../src/types/bridge.js';
import type { AudioFeaturesRow } from '../src/types/cache.js';
import { asError, featuresRow, makeBridge } from './helpers.js';
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
      bpmConfidence: null,
      bpmMaturity: null,
      musicalKey: index % 5 === 0 ? null : ['C major', 'D minor', 'F# minor'][index % 3]!,
      camelot: null,
      keyConfidence: null,
      keyMaturity: null,
      danceability: index % 7 === 0 ? null : 0.35 + (index % 50) / 100,
      sources: { musicalKey: 'acousticbrainz', danceability: 'acousticbrainz' },
      mbRecordingMbid: `mbid-large-${index}`,
      deezerTrackId: null,
      status: 'ok',
      catalogStatus: 'ok',
      analysisStatus: null,
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

// A deliberate walk round the wheel, so every relation the tool can report
// appears once in a known order.
function makeHarmonicDraft(): { deps: ToolDeps; trackIds: string[] } {
  const keys: (string | null)[] = [
    'A minor', // 8A
    'E minor', // 9A  — one step up
    'G major', // 9B  — relative major
    'A major', // 11B — two steps up
    'F', // no mode, so no wheel position
    'F minor', // 4A
    'F minor', // 4A  — same key
    'C major', // 8B  — four steps away, other mode
  ];
  const tracks: RawTrack[] = keys.map((_, index) => ({
    persistentId: `T-HARM-${index + 1}`,
    title: `Harmonic ${index + 1}`,
    artist: 'Wheel',
    durationSeconds: 200,
    playCount: 0,
    skipCount: 0,
  }));
  const features: AudioFeaturesRow[] = keys.map((musicalKey, index) => ({
    trackPersistentId: `T-HARM-${index + 1}`,
    bpm: null,
    bpmConfidence: null,
    bpmMaturity: null,
    musicalKey,
    camelot: null,
    keyConfidence: musicalKey == null ? null : 0.7,
    // Only the fourth track's key is a provisional estimate.
    keyMaturity: musicalKey == null ? null : index === 3 ? 'provisional' : 'validated',
    danceability: null,
    sources: { musicalKey: 'acousticbrainz' },
    mbRecordingMbid: null,
    deezerTrackId: null,
    status: 'ok',
    catalogStatus: 'ok',
    analysisStatus: null,
    fetchedAt: '2026-09-01T00:00:00.000Z',
  }));
  const cache = SelectaCache.open(':memory:');

  cache.refreshFromSnapshot(
    { capturedAt: '2026-09-01T12:00:00.000Z', tracks, playlists: [] },
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
      camelot: '11A',
      danceability: 0.73,
      bpm_confidence: 0.93,
      bpm_maturity: 'validated',
      key_confidence: 0.61,
      key_maturity: 'provisional',
      bpm_source: 'deezer',
      key_source: 'acousticbrainz',
      signal: { play_count: 12, skip_count: 1, rating: 4, loved: true },
    });
    // Only this view carries trust, and only where a source recorded it.
    expect(JSON.parse(JSON.stringify(out.tracks[1]))).not.toHaveProperty('key_confidence');
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

  it('names what produced each tempo and key, and omits what was never recorded', async () => {
    const deps = makeDeps();

    deps.cache().saveAudioFeatures([
      featuresRow({
        trackPersistentId: 'T-BARE',
        bpm: 124,
        musicalKey: 'A minor',
        danceability: null,
        sources: {
          bpm: 'metrognome/onset-autocorrelation-comb@2',
          musicalKey: 'metrognome/chroma-correlation-edm@2',
        },
      }),
    ]);
    const out = await inspect(deps);
    const sources = out.tracks.map(({ bpm_source, key_source }) => ({ bpm_source, key_source }));

    expect(JSON.parse(JSON.stringify(sources))).toEqual([
      { bpm_source: 'deezer', key_source: 'acousticbrainz' },
      // The native Music.app tag is the effective tempo when nothing was enriched.
      { bpm_source: 'music_app' },
      { key_source: 'acousticbrainz' },
      { bpm_source: 'deezer', key_source: 'acousticbrainz' },
      {
        bpm_source: 'metrognome/onset-autocorrelation-comb@2',
        key_source: 'metrognome/chroma-correlation-edm@2',
      },
    ]);
  });

  it('never credits the Music.app tag for an enriched tempo with no recorded source', async () => {
    const deps = makeDeps();

    deps
      .cache()
      .saveAudioFeatures([
        featuresRow({ trackPersistentId: 'T-TURN', bpm: 120, musicalKey: null, sources: null }),
      ]);
    const turn = (await inspect(deps)).tracks[1]!;

    expect(turn.bpm).toBe(120);
    expect(JSON.parse(JSON.stringify(turn))).not.toHaveProperty('bpm_source');
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

  it('names every relation between adjacent wheel positions, in draft order', async () => {
    const { deps, trackIds } = makeHarmonicDraft();
    const out = (await handleInspectTracklist(
      { track_ids: trackIds },
      deps,
    )) as InspectTracklistOutput;

    expect(out.tracks.map((track) => track.camelot ?? null)).toEqual([
      '8A',
      '9A',
      '9B',
      '11B',
      null,
      '4A',
      '4A',
      '8B',
    ]);
    expect(out.harmonic.transitions).toEqual([
      { from_position: 0, relation: 'adjacent' },
      { from_position: 1, relation: 'relative' },
      { from_position: 2, relation: 'energy_boost', provisional: true },
      { from_position: 3, relation: 'unknown', provisional: true },
      { from_position: 4, relation: 'unknown' },
      { from_position: 5, relation: 'same' },
      { from_position: 6, relation: 'distant' },
    ]);
    expect(out.harmonic.by_relation).toEqual({
      same: 1,
      adjacent: 1,
      relative: 1,
      energy_boost: 1,
      distant: 1,
      unknown: 2,
    });
  });

  it('separates a key with no wheel position from a missing key, and never guesses either', async () => {
    const { deps, trackIds } = makeHarmonicDraft();
    const out = (await handleInspectTracklist(
      { track_ids: trackIds },
      deps,
    )) as InspectTracklistOutput;

    // The fifth track has a key ("F") but no mode, so it counts as covered
    // while still having no position on the wheel.
    expect(out.feature_coverage.musical_key).toEqual({ present_count: 8, missing_count: 0 });
    expect(out.feature_gaps.some((gap) => gap.missing.includes('musical_key'))).toBe(false);
    expect(out.harmonic.unknown_key_positions).toEqual([4]);
    expect(out.harmonic.provisional_key_positions).toEqual([3]);
  });

  it('treats a stored camelot it cannot parse as no position at all', async () => {
    // A key metrognome could not parse keeps whatever camelot its source gave
    // (`withCamelot`), and migration 4 preserves it — so a non-null value that
    // is not a wheel position reaches this code.
    const tracks: RawTrack[] = ['T-JUNK', 'T-REAL'].map((persistentId) => ({
      persistentId,
      title: persistentId,
      artist: 'Wheel',
      durationSeconds: 200,
      playCount: 0,
      skipCount: 0,
    }));
    const cache = SelectaCache.open(':memory:');

    cache.refreshFromSnapshot(
      { capturedAt: '2026-09-01T12:00:00.000Z', tracks, playlists: [] },
      { durationMs: 1 },
    );
    cache.saveAudioFeatures([
      {
        trackPersistentId: 'T-JUNK',
        bpm: null,
        bpmConfidence: null,
        bpmMaturity: null,
        musicalKey: null,
        camelot: 'kept',
        keyConfidence: null,
        keyMaturity: 'provisional',
        danceability: null,
        sources: null,
        mbRecordingMbid: null,
        deezerTrackId: null,
        status: 'ok',
        catalogStatus: 'ok',
        analysisStatus: null,
        fetchedAt: '2026-09-01T00:00:00.000Z',
      },
      {
        trackPersistentId: 'T-REAL',
        bpm: null,
        bpmConfidence: null,
        bpmMaturity: null,
        musicalKey: 'A minor',
        camelot: null,
        keyConfidence: 0.9,
        keyMaturity: 'validated',
        danceability: null,
        sources: null,
        mbRecordingMbid: null,
        deezerTrackId: null,
        status: 'ok',
        catalogStatus: 'ok',
        analysisStatus: null,
        fetchedAt: '2026-09-01T00:00:00.000Z',
      },
    ]);

    const out = (await handleInspectTracklist(
      { track_ids: ['T-JUNK', 'T-REAL'] },
      {
        cache: () => cache,
        bridge: makeBridge(),
      },
    )) as InspectTracklistOutput;

    expect(out.tracks[0]!.camelot).toBe('kept');
    expect(out.harmonic.transitions).toEqual([
      { from_position: 0, relation: 'unknown', provisional: true },
    ]);
    // Unparseable is off the wheel, so it counts as unknown and never as a
    // provisional position the relation calculation would refuse to read.
    expect(out.harmonic.unknown_key_positions).toEqual([0]);
    expect(out.harmonic.provisional_key_positions).toEqual([]);
  });

  it('reports no transitions for a single track', async () => {
    const { deps } = makeHarmonicDraft();
    const out = (await handleInspectTracklist(
      { track_ids: ['T-HARM-1'] },
      deps,
    )) as InspectTracklistOutput;

    expect(out.harmonic.transitions).toEqual([]);
    expect(out.harmonic.by_relation.unknown).toBe(0);
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
