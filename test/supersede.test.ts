import { describe, expect, it } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import { supersedeFeatures } from '../src/cache/audio_features.js';
import { featuresRow } from './helpers.js';
import { expectOnlyChanged, snapshotCache } from './table_diff.js';
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
      const plan = cache.planSupersedeFeatures('analysis', [ANALYSIS_KEY]);
      const result = cache.applySupersedeFeatures(plan);

      expect(result).toMatchObject({
        tracks: 1,
        cleared_fields: { musicalKey: 1 },
        rows_removed: 0,
      });
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
      const plan = cache.planSupersedeFeatures('analysis', [ANALYSIS_KEY]);

      expect(cache.applySupersedeFeatures(plan)).toMatchObject({ tracks: 1 });
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
      expect(() => cache.planSupersedeFeatures('analysis', ['acousticbrainz'])).toThrow(
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

  it('names whose values each cleared field came from', () => {
    const cache = loaded([
      featuresRow({ sources: { bpm: ANALYSIS_BPM, musicalKey: ANALYSIS_KEY } }),
      featuresRow({ trackPersistentId: 'T-ANGEL', sources: { bpm: ANALYSIS_BPM } }),
    ]);

    try {
      // A count alone cannot answer "whose data am I about to lose"; the dry
      // run has to say which algorithm each number belongs to.
      expect(
        cache.planSupersedeFeatures('analysis', [ANALYSIS_BPM, ANALYSIS_KEY]).summary.by_provenance,
      ).toEqual({
        [ANALYSIS_BPM]: { bpm: 2 },
        [ANALYSIS_KEY]: { musicalKey: 1 },
      });
    } finally {
      cache.close();
    }
  });

  it('plans without writing anything at all', () => {
    const cache = loaded([featuresRow({ sources: { musicalKey: ANALYSIS_KEY } })]);

    try {
      const before = snapshotCache(cache.db);

      expect(cache.planSupersedeFeatures('analysis', [ANALYSIS_KEY]).summary.tracks).toBe(1);
      expectOnlyChanged(before, snapshotCache(cache.db), []);
    } finally {
      cache.close();
    }
  });

  it('changes exactly the rows and columns its summary accounts for', () => {
    const cache = loaded([
      featuresRow({ sources: { bpm: 'deezer', musicalKey: ANALYSIS_KEY }, analysisStatus: 'ok' }),
      featuresRow({ trackPersistentId: 'T-ANGEL', sources: { musicalKey: 'acousticbrainz' } }),
    ]);

    try {
      const before = snapshotCache(cache.db);

      cache.applySupersedeFeatures(cache.planSupersedeFeatures('analysis', [ANALYSIS_KEY]));

      // The whole database, not just the row under test: a clear that reaches
      // past what it reported is the bug this pattern exists to catch.
      expectOnlyChanged(before, snapshotCache(cache.db), [
        {
          table: 'audio_features',
          key: 'T-TEARDROP',
          change: 'changed',
          fields: ['analysis_status', 'camelot', 'musical_key', 'sources'],
        },
      ]);
    } finally {
      cache.close();
    }
  });

  it('skips a track pruned between deciding and writing', () => {
    const cache = loaded([featuresRow({ sources: { musicalKey: ANALYSIS_KEY } })]);

    try {
      const plan = cache.planSupersedeFeatures('analysis', [ANALYSIS_KEY]);
      const snapshot = fixture as LibrarySnapshot;

      // supersede holds the enrich lock, refresh holds the music one, so this
      // interleaving is reachable. The row is already gone; rewriting it would
      // resurrect an orphan, and reporting it would overstate what moved.
      cache.refreshFromSnapshot(
        { ...snapshot, tracks: snapshot.tracks.filter((t) => t.persistentId !== 'T-TEARDROP') },
        { durationMs: 1 },
      );

      expect(cache.applySupersedeFeatures(plan)).toMatchObject({ tracks: 0 });
      expect(cache.getAudioFeatures('T-TEARDROP')).toBeNull();
    } finally {
      cache.close();
    }
  });

  it('refuses a provenance no stored feature came from', () => {
    const cache = loaded();

    try {
      expect(() => cache.planSupersedeFeatures('analysis', ['metrognome/chroma@9'])).toThrow(
        /no stored feature came from/,
      );
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
