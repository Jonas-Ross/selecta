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
      skipped: 0,
      pendingRemaining: 0,
      errors: [],
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

  it('treats a negative limit as zero, never as SQLite-unlimited', async () => {
    // Regression (PR #29 review): LIMIT -1 means "no limit" to SQLite — a
    // caller bug must not become a full-library crawl of external services.
    expect(cache.getTracksPendingEnrichment(-1)).toEqual([]);
    const { fetchLike, calls } = fakeFetch(scenarioHandler);
    const summary = await enrichPendingTracks(cache, { limit: -1 }, testDeps(fetchLike));
    expect(summary.processed).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('respects the batch limit and reports the rest as pending', async () => {
    const { fetchLike } = fakeFetch(scenarioHandler);
    const summary = await enrichPendingTracks(cache, { limit: 2 }, testDeps(fetchLike));
    expect(summary.processed).toBe(2);
    expect(summary.pendingRemaining).toBe(4);
    expect(cache.getAudioFeatures('T-MIDNIGHT')).not.toBeNull();
    expect(cache.getAudioFeatures('T-GLORYBOX')).toBeNull();
  });

  it('narrates every source request through trace', async () => {
    const { fetchLike } = fakeFetch(scenarioHandler);
    const lines: string[] = [];
    await enrichPendingTracks(cache, { limit: 10 }, {
      ...testDeps(fetchLike),
      trace: (line) => lines.push(line),
    });
    const text = lines.join('\n');
    expect(text).toContain('chunk 1/1');
    expect(text).toContain('MusicBrainz "Teardrop" — Massive Attack …');
    expect(text).toContain('AcousticBrainz bulk low-level');
    expect(text).toContain('Deezer "Midnight City" — M83 …');
    expect(text).toContain('↳ bpm 105');
    expect(text).toContain('chunk saved — 2 ok, 1 no_data, 3 no_match');
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

  it('paces every request on every host, including the first of a run', async () => {
    // Frozen clock → the throttles always see zero elapsed time, so each
    // request must wait out its host's full spacing. Limit 2 (Midnight City +
    // Teardrop): 2 MB searches, one AB bulk low-level + one high-level for
    // the chunk, then Midnight City's 2 Deezer calls for the bpm gap.
    const { fetchLike } = fakeFetch(scenarioHandler);
    const sleeps: number[] = [];
    await enrichPendingTracks(cache, { limit: 2 }, {
      fetchLike,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => new Date('2026-07-04T00:00:00.000Z'),
    });
    // 2 MusicBrainz + 2 AcousticBrainz waits at ≥1s, 2 Deezer waits at ≥200ms.
    expect(sleeps.filter((ms) => ms >= 1000)).toHaveLength(4);
    expect(sleeps).toHaveLength(6);
    for (const ms of sleeps) expect(ms).toBeGreaterThanOrEqual(200);
  });

  it('never re-attempts a track with a row — all statuses are terminal', async () => {
    const { fetchLike, calls } = fakeFetch(scenarioHandler);
    await enrichPendingTracks(cache, { limit: 10 }, testDeps(fetchLike));
    const callsAfterFirstRun = calls.length;

    const summary = await enrichPendingTracks(cache, { limit: 10 }, testDeps(fetchLike));
    expect(summary.processed).toBe(0);
    expect(calls.length).toBe(callsAfterFirstRun);
  });

  it('skips the chunk on a source failure — nothing half-written, tracks stay pending', async () => {
    const { fetchLike } = fakeFetch((url) => {
      if (decodeURIComponent(url).includes('Teardrop')) return [503, { error: 'rate limited' }];
      return scenarioHandler(url);
    });
    const chunkErrors: [string, number][] = [];
    const summary = await enrichPendingTracks(cache, { limit: 10 }, {
      ...testDeps(fetchLike),
      onChunkError: (message, trackCount) => chunkErrors.push([message, trackCount]),
    });
    expect(summary.processed).toBe(0);
    expect(summary.skipped).toBe(6); // the whole (single) chunk
    expect(summary.pendingRemaining).toBe(6);
    expect(summary.errors).toEqual([expect.stringContaining('MusicBrainz responded 503')]);
    expect(chunkErrors).toEqual([[expect.stringContaining('503'), 6]]);
    expect(cache.getAudioFeatures('T-MIDNIGHT')).toBeNull();
  });

  it('continues past a failed chunk to the next one', async () => {
    // 30 synthetic tracks → two chunks (25 + 5), play-count order T-01…T-30.
    // Chunk 1 dies on Song 10's MusicBrainz call; chunk 2 must still land.
    const big = SelectaCache.open(':memory:');
    big.refreshFromSnapshot(
      {
        capturedAt: '2026-07-04T00:00:00.000Z',
        tracks: Array.from({ length: 30 }, (_, i) => ({
          persistentId: `T-${String(i + 1).padStart(2, '0')}`,
          title: `Song ${String(i + 1).padStart(2, '0')}`,
          artist: `Artist ${i + 1}`,
          durationSeconds: 200,
          playCount: 100 - i,
        })),
        playlists: [],
      } as LibrarySnapshot,
      { durationMs: 1 },
    );
    const { fetchLike } = fakeFetch((url) => {
      const u = decodeURIComponent(url);
      if (u.includes('Song 10')) return [503, { error: 'gateway' }];
      if (u.includes('musicbrainz.org')) return [200, { recordings: [] }];
      if (u.includes('api.deezer.com/search')) return [200, { data: [] }];
      throw new Error(`unrouted url: ${url}`);
    });
    const summary = await enrichPendingTracks(big, { limit: 30 }, testDeps(fetchLike));
    expect(summary.skipped).toBe(25); // chunk 1 lost to the 503
    expect(summary.processed).toBe(5); // chunk 2 completed (all no_match)
    expect(summary.noMatch).toBe(5);
    expect(summary.pendingRemaining).toBe(25);
    expect(big.getAudioFeatures('T-26')).toMatchObject({ status: 'no_match' });
    expect(big.getAudioFeatures('T-10')).toBeNull();
  });

  it('strips embedded quotes from Deezer query fields (no escape exists)', async () => {
    // Regression (PR #29 review): an embedded " ends the artist:/track: field
    // early on Deezer's side and fabricates a terminal no_match.
    const quoted = SelectaCache.open(':memory:');
    quoted.refreshFromSnapshot(
      {
        capturedAt: '2026-07-04T00:00:00.000Z',
        tracks: [
          {
            persistentId: 'T-Q',
            title: 'Say "Boom" Again',
            artist: 'The "Q" Band',
            durationSeconds: 200,
            playCount: 1,
          },
        ],
        playlists: [],
      } as LibrarySnapshot,
      { durationMs: 1 },
    );
    const { fetchLike, calls } = fakeFetch((url) => {
      const u = decodeURIComponent(url);
      if (u.includes('musicbrainz.org')) return [200, { recordings: [] }];
      if (u.includes('api.deezer.com/search')) return [200, { data: [] }];
      throw new Error(`unrouted url: ${url}`);
    });
    await enrichPendingTracks(quoted, { limit: 1 }, testDeps(fetchLike));
    const dzCall = decodeURIComponent(calls.find((c) => c.includes('deezer'))!);
    expect(dzCall).toContain('artist:"The Q Band" track:"Say Boom Again"');
  });

  it('reports transport failures naming the source, without failing the run', async () => {
    const fetchLike: FetchLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND musicbrainz.org');
    };
    const summary = await enrichPendingTracks(cache, { limit: 6 }, testDeps(fetchLike));
    expect(summary.skipped).toBe(6);
    expect(summary.errors).toEqual([
      expect.stringContaining('MusicBrainz unreachable: getaddrinfo ENOTFOUND'),
    ]);
  });

  it('treats a Deezer in-body error as a chunk skip, never as data', async () => {
    const { fetchLike } = fakeFetch((url) => {
      const u = decodeURIComponent(url);
      if (u.includes('api.deezer.com/search'))
        return [200, { error: { message: 'Quota limit exceeded' } }];
      return scenarioHandler(url);
    });
    const summary = await enrichPendingTracks(cache, { limit: 1 }, testDeps(fetchLike));
    expect(summary.skipped).toBe(1);
    expect(summary.errors).toEqual([expect.stringContaining('Quota limit exceeded')]);
    expect(cache.getAudioFeatures('T-MIDNIGHT')).toBeNull();
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

  it('reports skipped chunks in the summary instead of failing the call', async () => {
    const fetchLike: FetchLike = async () => {
      throw new Error('network down');
    };
    const out = (await handleEnrichFeatures({}, makeDeps(fetchLike))) as EnrichFeaturesOutput;
    expect(out.processed).toBe(0);
    expect(out.skipped).toBe(6);
    expect(out.pending_remaining).toBe(6);
    expect(out.source_errors).toEqual([expect.stringContaining('MusicBrainz unreachable')]);
  });
});
