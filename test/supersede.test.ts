import { describe, expect, it } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import { supersedeFeatures } from '../src/cache/audio_features.js';
import { featuresRow } from './helpers.js';
import fixture from './fixtures/library.json' with { type: 'json' };
import type { LibrarySnapshot } from '../src/types/bridge.js';

const ANALYSIS_KEY = 'metrognome/chroma-correlation-edm@1';
const ANALYSIS_BPM = 'metrognome/onset-autocorrelation-comb@1';

function loaded(rows = [featuresRow()]): SelectaCache {
  const cache = SelectaCache.open(':memory:');

  cache.refreshFromSnapshot(fixture as LibrarySnapshot, { durationMs: 1 });
  cache.saveAudioFeatures(rows);

  return cache;
}

describe('superseding a stale algorithm', () => {
  it('clears only the fields the named algorithm produced', () => {
    const row = featuresRow({
      sources: { bpm: 'deezer', musicalKey: ANALYSIS_KEY, danceability: 'acousticbrainz' },
      analysisStatus: 'ok',
    });
    const result = supersedeFeatures(row, 'analysis', new Set([ANALYSIS_KEY]));

    expect(result).toMatchObject({ action: 'update', clearedFields: ['musicalKey'] });

    if (result.action !== 'update') throw new Error('expected an update');

    // The key and everything that described it goes; the catalog's own
    // values, and the catalog's terminal record, stay exactly as they were.
    expect(result.row).toMatchObject({
      musicalKey: null,
      camelot: null,
      keyConfidence: null,
      keyMaturity: null,
      bpm: row.bpm,
      danceability: row.danceability,
      sources: { bpm: 'deezer', danceability: 'acousticbrainz' },
      analysisStatus: null,
      catalogStatus: 'ok',
      status: 'ok',
    });
  });

  it('leaves a row whose provenance was not named alone', () => {
    const row = featuresRow({ sources: { musicalKey: 'acousticbrainz' } });

    expect(supersedeFeatures(row, 'analysis', new Set([ANALYSIS_KEY]))).toEqual({
      action: 'unchanged',
    });
  });

  it('removes a row that has nothing left to say', () => {
    const row = featuresRow({
      bpm: 120,
      musicalKey: null,
      camelot: null,
      danceability: null,
      sources: { bpm: ANALYSIS_BPM },
      catalogStatus: null,
      analysisStatus: 'ok',
    });

    expect(supersedeFeatures(row, 'analysis', new Set([ANALYSIS_BPM]))).toEqual({
      action: 'delete',
      clearedFields: ['bpm'],
    });
  });

  it('reopens the backlog so a later run reaches the track again', () => {
    const cache = loaded([
      featuresRow({
        sources: { bpm: 'deezer', musicalKey: ANALYSIS_KEY },
        danceability: null,
        catalogStatus: 'ok',
        analysisStatus: 'ok',
      }),
    ]);

    try {
      const before = cache.countPendingEnrichment('analysis');
      const result = cache.supersedeFeatures('analysis', [ANALYSIS_KEY]);

      expect(result).toMatchObject({ tracks: 1, clearedFields: { musicalKey: 1 }, rowsRemoved: 0 });
      expect(cache.countPendingEnrichment('analysis')).toBe(before + 1);
      expect(cache.getAudioFeatures('T-TEARDROP')).toMatchObject({
        musicalKey: null,
        bpm: 78.42,
        analysisStatus: null,
        catalogStatus: 'ok',
      });
    } finally {
      cache.close();
    }
  });

  it('survives rows that carry an attempt and no provenance at all', () => {
    // Most of a real library's rows are exactly this: a terminal no_data or
    // no_match with nothing measured.
    const cache = loaded([
      featuresRow({ sources: { musicalKey: ANALYSIS_KEY }, analysisStatus: 'ok' }),
      featuresRow({
        trackPersistentId: 'T-ANGEL',
        bpm: null,
        musicalKey: null,
        camelot: null,
        danceability: null,
        sources: null,
        status: 'no_data',
        analysisStatus: 'no_data',
        catalogStatus: null,
      }),
    ]);

    try {
      expect(cache.supersedeFeatures('analysis', [ANALYSIS_KEY])).toMatchObject({ tracks: 1 });
      expect(cache.getAudioFeatures('T-ANGEL')).toMatchObject({ analysisStatus: 'no_data' });
    } finally {
      cache.close();
    }
  });

  it('leaves a value the reopened source did not measure', () => {
    // Clearing the catalog's key while reopening analysis would strand it:
    // catalog_status stays terminal, so no later run refetches it, and the
    // provenance is gone so a second supersede cannot find the row either.
    const row = featuresRow({
      sources: { bpm: ANALYSIS_BPM, musicalKey: 'acousticbrainz' },
      catalogStatus: 'ok',
      analysisStatus: 'ok',
    });
    const result = supersedeFeatures(row, 'analysis', new Set([ANALYSIS_BPM, 'acousticbrainz']));

    expect(result).toMatchObject({ action: 'update', clearedFields: ['bpm'] });

    if (result.action !== 'update') throw new Error('expected an update');

    expect(result.row).toMatchObject({
      bpm: null,
      musicalKey: row.musicalKey,
      sources: { musicalKey: 'acousticbrainz' },
      catalogStatus: 'ok',
      analysisStatus: null,
    });
  });

  it('refuses a provenance the named source never produced', () => {
    const cache = loaded();

    try {
      expect(() => cache.supersedeFeatures('analysis', ['acousticbrainz'])).toThrow(
        /not produced by analysis/,
      );
      // Refused before anything was written.
      expect(cache.getAudioFeatures('T-TEARDROP')).toMatchObject({
        musicalKey: 'A minor',
        catalogStatus: 'ok',
      });
    } finally {
      cache.close();
    }
  });

  it('reports what produced each stored value', () => {
    const cache = loaded();

    try {
      expect(cache.featureProvenance()).toEqual(
        expect.arrayContaining([
          { field: 'bpm', provenance: 'deezer', trackCount: 1 },
          { field: 'musicalKey', provenance: 'acousticbrainz', trackCount: 1 },
          { field: 'danceability', provenance: 'acousticbrainz', trackCount: 1 },
        ]),
      );
    } finally {
      cache.close();
    }
  });
});
