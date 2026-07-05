// Enrichment layer: match heuristics pure, engine + tool handler against
// in-memory SQLite with a canned FetchLike — no real network, ever.

import { describe, it, expect, beforeEach } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import { enrichPendingTracks, type FetchLike } from '../src/enrich/index.js';
import {
  durationCompatible,
  luceneEscape,
  primaryArtist,
  stripFeat,
} from '../src/enrich/match.js';
import { handleEnrichFeatures, type EnrichFeaturesOutput } from '../src/tools/enrich_features.js';
import type { ToolDeps } from '../src/tools/common.js';
import type { LibrarySnapshot } from '../src/types/bridge.js';
import { BridgeError } from '../src/types/errors.js';
import { asError, makeBridge } from './helpers.js';
import fixture from './fixtures/library.json' with { type: 'json' };

const snapshot = fixture as LibrarySnapshot;

describe('match heuristics', () => {
  it('strips feat clauses in parentheses, brackets, and bare tails', () => {
    expect(stripFeat('Llove (feat. Haley) [Extended Mix]')).toBe('Llove [Extended Mix]');
    expect(stripFeat('Footprints [with Cruickshank]')).toBe('Footprints');
    expect(stripFeat('The Monster feat. Rihanna')).toBe('The Monster');
    expect(stripFeat('Teardrop')).toBe('Teardrop');
  });

  it('reduces multi-artist credits to the first credited artist', () => {
    expect(primaryArtist('Tiësto, Odd Mob & Goodboys')).toBe('Tiësto');
    expect(primaryArtist('Calvin Harris Feat. Ayah Marar')).toBe('Calvin Harris');
    expect(primaryArtist('KAROL G x Feid')).toBe('KAROL G');
    // A trailing standalone X is part of the name, not a collab separator.
    expect(primaryArtist('Lil Nas X')).toBe('Lil Nas X');
  });

  it('gates duration at ±10s and lets unknown lengths pass', () => {
    expect(durationCompatible(300, 309)).toBe(true);
    expect(durationCompatible(300, 311)).toBe(false);
    expect(durationCompatible(null, 300)).toBe(true);
    expect(durationCompatible(300, null)).toBe(true);
  });

  it('escapes Lucene syntax in titles', () => {
    expect(luceneEscape('W.D.Y.W.F.M?')).toBe('W.D.Y.W.F.M\\?');
    expect(luceneEscape('AC/DC')).toBe('AC\\/DC');
  });
});

// ── Canned network ───────────────────────────────────────────────────────────
// Routes the six fixture tracks through every terminal path:
//   Midnight City → MB hit, absent from AB, Deezer bpm → ok (bpm via deezer)
//   Teardrop      → MB hit, AB bulk full data          → ok (all via acousticbrainz)
//   Glory Box     → MB empty, Deezer empty             → no_match
//   Angel         → MB hit, absent from AB, Deezer bpm 0 → no_data
//   Roads         → MB low score, Deezer bad duration  → no_match
//   T-BARE        → no artist/title                    → no_match, zero requests
// AB responds via the bulk endpoints (the only usable ones): an MBID simply
// missing from the body is the no-data case.

function scenarioHandler(url: string): [number, unknown] {
  const u = decodeURIComponent(url);
  if (u.includes('musicbrainz.org')) {
    if (u.includes('Midnight City'))
      return [200, { recordings: [{ id: 'mb-midnight', score: 100, length: 244000 }] }];
    if (u.includes('Teardrop'))
      return [200, { recordings: [{ id: 'mb-teardrop', score: 100, length: 331000 }] }];
    if (u.includes('Angel'))
      return [200, { recordings: [{ id: 'mb-angel', score: 97, length: 379000 }] }];
    if (u.includes('Roads'))
      return [200, { recordings: [{ id: 'mb-wrong-roads', score: 60, length: 304000 }] }];
    return [200, { recordings: [] }];
  }
  if (u.includes('acousticbrainz.org')) {
    if (!u.includes('recording_ids=')) throw new Error(`non-bulk AB url: ${url}`);
    if (u.includes('low-level'))
      return [
        200,
        { 'mb-teardrop': { '0': { rhythm: { bpm: 78.42 }, tonal: { key_key: 'A', key_scale: 'minor' } } } },
      ];
    return [
      200,
      { 'mb-teardrop': { '0': { highlevel: { danceability: { all: { danceable: 0.618 } } } } } },
    ];
  }
  if (u.includes('api.deezer.com/search')) {
    if (u.includes('Midnight City')) return [200, { data: [{ id: 901, duration: 246 }] }];
    if (u.includes('Angel')) return [200, { data: [{ id: 77, duration: 379 }] }];
    if (u.includes('Roads')) return [200, { data: [{ id: 55, duration: 500 }] }]; // duration gate rejects
    return [200, { data: [] }];
  }
  if (u.includes('api.deezer.com/track/901')) return [200, { bpm: 105 }];
  if (u.includes('api.deezer.com/track/77')) return [200, { bpm: 0 }]; // Deezer's "unknown"
  throw new Error(`unrouted url: ${url}`);
}

function fakeFetch(handler: (url: string) => [number, unknown]): {
  fetchLike: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchLike: FetchLike = async (url) => {
    calls.push(url);
    const [status, body] = handler(url);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchLike, calls };
}

const testDeps = (fetchLike: FetchLike) => ({
  fetchLike,
  sleep: async () => {},
  now: () => new Date('2026-07-04T00:00:00.000Z'),
});

describe('enrichPendingTracks', () => {
  let cache: SelectaCache;
  beforeEach(() => {
    cache = SelectaCache.open(':memory:');
    cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
  });

  it('resolves a batch through every terminal path', async () => {
    const { fetchLike, calls } = fakeFetch(scenarioHandler);
    const summary = await enrichPendingTracks(cache, { limit: 10 }, testDeps(fetchLike));

    expect(summary).toEqual({
      processed: 6,
      enriched: 2,
      noData: 1,
      noMatch: 3,
      pendingRemaining: 0,
    });

    // Most-played first: Midnight City (55 plays) hits MusicBrainz before Teardrop (42).
    expect(decodeURIComponent(calls[0]!)).toContain('Midnight City');

    expect(cache.getAudioFeatures('T-MIDNIGHT')).toMatchObject({
      bpm: 105,
      musicalKey: null,
      sources: { bpm: 'deezer' },
      mbRecordingMbid: 'mb-midnight',
      deezerTrackId: 901,
      status: 'ok',
      fetchedAt: '2026-07-04T00:00:00.000Z',
    });
    expect(cache.getAudioFeatures('T-TEARDROP')).toMatchObject({
      bpm: 78.42,
      musicalKey: 'A minor',
      danceability: 0.618,
      sources: { bpm: 'acousticbrainz', musicalKey: 'acousticbrainz', danceability: 'acousticbrainz' },
      status: 'ok',
    });
    // Matched somewhere but no source had data → no_data, match ids kept.
    expect(cache.getAudioFeatures('T-ANGEL')).toMatchObject({
      status: 'no_data',
      bpm: null,
      mbRecordingMbid: 'mb-angel',
      deezerTrackId: 77,
      sources: null,
    });
    // MB score gate and Deezer duration gate both refused → no_match.
    expect(cache.getAudioFeatures('T-ROADS')).toMatchObject({
      status: 'no_match',
      mbRecordingMbid: null,
      deezerTrackId: null,
    });
    expect(cache.getAudioFeatures('T-GLORYBOX')).toMatchObject({ status: 'no_match' });
    expect(cache.getAudioFeatures('T-BARE')).toMatchObject({ status: 'no_match' });

    // The enriched bpm now shadows Glory Box's native tag on track reads.
    expect(cache.getTrack('T-MIDNIGHT')!.bpm).toBe(105);
    expect(cache.getTrack('T-GLORYBOX')!.bpm).toBe(95); // native tag survives no_match
  });

  it('respects the batch limit and reports the rest as pending', async () => {
    const { fetchLike } = fakeFetch(scenarioHandler);
    const summary = await enrichPendingTracks(cache, { limit: 2 }, testDeps(fetchLike));
    expect(summary.processed).toBe(2);
    expect(summary.pendingRemaining).toBe(4);
    expect(cache.getAudioFeatures('T-MIDNIGHT')).not.toBeNull();
    expect(cache.getAudioFeatures('T-GLORYBOX')).toBeNull();
  });

  it('reports progress after each saved chunk', async () => {
    const { fetchLike } = fakeFetch(scenarioHandler);
    const ticks: number[] = [];
    await enrichPendingTracks(cache, { limit: 3 }, {
      ...testDeps(fetchLike),
      onProgress: (p) => ticks.push(p.processed),
    });
    expect(ticks).toEqual([3]); // 3 tracks = one chunk
  });

  it('paces every MusicBrainz and AcousticBrainz request, including the first of a run', async () => {
    // Frozen clock → the throttle always sees zero elapsed time, so each
    // rate-limited request must wait out its host's full spacing. Limit 2
    // (Midnight City + Teardrop): 2 MB searches, then one AB bulk low-level
    // + one bulk high-level for the chunk.
    const { fetchLike } = fakeFetch(scenarioHandler);
    const sleeps: number[] = [];
    await enrichPendingTracks(cache, { limit: 2 }, {
      fetchLike,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => new Date('2026-07-04T00:00:00.000Z'),
    });
    // 2 MusicBrainz + 2 AcousticBrainz requests → 4 waits (Deezer unthrottled:
    // its 50 req/5s ceiling is unreachable at this cadence).
    expect(sleeps).toHaveLength(4);
    for (const ms of sleeps) expect(ms).toBeGreaterThanOrEqual(1000);
  });

  it('never re-attempts a track with a row — all statuses are terminal', async () => {
    const { fetchLike, calls } = fakeFetch(scenarioHandler);
    await enrichPendingTracks(cache, { limit: 10 }, testDeps(fetchLike));
    const callsAfterFirstRun = calls.length;

    const summary = await enrichPendingTracks(cache, { limit: 10 }, testDeps(fetchLike));
    expect(summary.processed).toBe(0);
    expect(calls.length).toBe(callsAfterFirstRun);
  });

  it('aborts on a source failure, losing at most the in-flight chunk', async () => {
    const { fetchLike } = fakeFetch((url) => {
      if (decodeURIComponent(url).includes('Teardrop')) return [503, { error: 'rate limited' }];
      return scenarioHandler(url);
    });
    await expect(
      enrichPendingTracks(cache, { limit: 10 }, testDeps(fetchLike)),
    ).rejects.toSatisfy(
      (err) => err instanceof BridgeError && err.errorCode === 'enrichment_error',
    );
    // The whole (single) chunk is unsaved — every track stays pending, so the
    // next run re-attempts them all. Nothing half-written.
    expect(cache.getAudioFeatures('T-MIDNIGHT')).toBeNull();
    expect(cache.countPendingEnrichment()).toBe(6);
  });

  it('translates transport failures into enrichment_error naming the source', async () => {
    const fetchLike: FetchLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND musicbrainz.org');
    };
    await expect(
      enrichPendingTracks(cache, { limit: 1 }, testDeps(fetchLike)),
    ).rejects.toSatisfy(
      (err) =>
        err instanceof BridgeError &&
        err.errorCode === 'enrichment_error' &&
        err.message.includes('MusicBrainz unreachable') &&
        err.message.includes('ENOTFOUND'),
    );
  });

  it('fails structurally on a Deezer in-body error instead of storing junk', async () => {
    const { fetchLike } = fakeFetch((url) => {
      const u = decodeURIComponent(url);
      if (u.includes('api.deezer.com/search'))
        return [200, { error: { message: 'Quota limit exceeded' } }];
      return scenarioHandler(url);
    });
    await expect(
      enrichPendingTracks(cache, { limit: 1 }, testDeps(fetchLike)),
    ).rejects.toSatisfy(
      (err) => err instanceof BridgeError && err.message.includes('Quota limit exceeded'),
    );
  });
});

describe('enrich_features tool', () => {
  function makeDeps(fetchLike: FetchLike): ToolDeps {
    const cache = SelectaCache.open(':memory:');
    cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
    return { cache: () => cache, bridge: makeBridge(), enrich: testDeps(fetchLike) };
  }

  it('runs a batch and reports the snake_case summary', async () => {
    const { fetchLike } = fakeFetch(scenarioHandler);
    const out = (await handleEnrichFeatures({ limit: 10 }, makeDeps(fetchLike))) as EnrichFeaturesOutput;
    expect(out).toEqual({
      processed: 6,
      enriched: 2,
      no_data: 1,
      no_match: 3,
      pending_remaining: 0,
    });
  });

  it('rejects an out-of-range limit', async () => {
    const { fetchLike } = fakeFetch(scenarioHandler);
    const err = asError(await handleEnrichFeatures({ limit: 0 }, makeDeps(fetchLike)));
    expect(err.error).toBe('validation_error');
  });

  it('envelopes a source failure with the progress-is-saved hint', async () => {
    const fetchLike: FetchLike = async () => {
      throw new Error('network down');
    };
    const err = asError(await handleEnrichFeatures({}, makeDeps(fetchLike)));
    expect(err.error).toBe('enrichment_error');
    expect(err.hint).toContain('saved');
  });
});
