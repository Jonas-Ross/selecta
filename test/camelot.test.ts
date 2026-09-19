// Camelot derivation, and the pin between it and the frozen backfill in
// migration 4 — the migration's text can never change under a shipped
// database, so a divergence has to surface here rather than in the data.

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { camelotFor } from '../src/domain/camelot.js';
import { MIGRATIONS } from '../src/cache/migrations.js';
import { SelectaCache } from '../src/cache/index.js';
import { featuresRow } from './helpers.js';
import type { LibrarySnapshot } from '../src/types/bridge.js';
import libraryFixture from './fixtures/library.json' with { type: 'json' };
import { readFileSync } from 'node:fs';

const snapshot = libraryFixture as LibrarySnapshot;

// The full wheel, written out rather than computed, so a change to the
// formula has to disagree with something a reader can check against a
// Camelot chart.
const WHEEL: Record<string, string> = {
  'G# minor': '1A',
  'B major': '1B',
  'Eb minor': '2A',
  'F# major': '2B',
  'Bb minor': '3A',
  'Db major': '3B',
  'F minor': '4A',
  'Ab major': '4B',
  'C minor': '5A',
  'Eb major': '5B',
  'G minor': '6A',
  'Bb major': '6B',
  'D minor': '7A',
  'F major': '7B',
  'A minor': '8A',
  'C major': '8B',
  'E minor': '9A',
  'G major': '9B',
  'B minor': '10A',
  'D major': '10B',
  'F# minor': '11A',
  'A major': '11B',
  'Db minor': '12A',
  'E major': '12B',
};

describe('camelotFor', () => {
  it('places all twenty-four keys on the wheel', () => {
    expect(Object.fromEntries(Object.keys(WHEEL).map((key) => [key, camelotFor(key)]))).toEqual(
      WHEEL,
    );
  });

  it('reads enharmonic spellings as the same position', () => {
    expect(camelotFor('A# minor')).toBe(camelotFor('Bb minor'));
    expect(camelotFor('C# major')).toBe(camelotFor('Db major'));
    expect(camelotFor('G# minor')).toBe(camelotFor('Ab minor'));
  });

  it('accepts the casing and spacing the sources actually emit', () => {
    expect(camelotFor('a minor')).toBe('8A');
    expect(camelotFor('F# MINOR')).toBe('11A');
    expect(camelotFor('  D major  ')).toBe('10B');
  });

  it('returns null for anything that is not a key', () => {
    // AcousticBrainz can supply a tonic with no scale; a mode-less key has no
    // position, and half a key is not worth guessing at.
    for (const input of ['A', 'H minor', 'A dorian', '', '   ', null, undefined]) {
      expect(camelotFor(input)).toBeNull();
    }
  });

  it('agrees with the position metrognome reports for the same key', () => {
    const recorded = readFileSync(new URL('./fixtures/metrognome.jsonl', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { features?: { key?: { key: string; camelot: string } } })
      .flatMap((analysis) => (analysis.features?.key != null ? [analysis.features.key] : []));

    expect(recorded.length).toBeGreaterThan(0);

    for (const key of recorded) expect(camelotFor(key.key)).toBe(key.camelot);
  });
});

describe('the migration 4 backfill', () => {
  it('derives the same position as camelotFor for every key it names', () => {
    const migration = MIGRATIONS.find((step) => step.version === 4)!;
    const keys = [...migration.sql.matchAll(/WHEN '([^']+)' THEN '([^']+)'/g)];

    expect(keys.length).toBe(42); // seven letters, three accidentals, two modes

    for (const [, key, position] of keys) expect(camelotFor(key!)).toBe(position);
  });

  it('fills every stored key and leaves an unparseable one as it was', () => {
    const db = new Database(':memory:');

    db.exec(
      MIGRATIONS.slice(0, 3)
        .map((step) => step.sql)
        .join('\n'),
    );
    db.exec(`
      INSERT INTO audio_features (track_persistent_id, musical_key, camelot, status, fetched_at)
      VALUES ('T-CATALOG', 'F minor', NULL, 'ok', '2026-09-01'),
             ('T-ANALYZED', 'A minor', '8A', 'ok', '2026-09-01'),
             ('T-SCALELESS', 'A', 'kept', 'ok', '2026-09-01'),
             ('T-NOKEY', NULL, NULL, 'no_data', '2026-09-01');
    `);
    db.exec(MIGRATIONS.find((step) => step.version === 4)!.sql);

    expect(
      db.prepare('SELECT track_persistent_id AS id, camelot FROM audio_features ORDER BY 1').all(),
    ).toEqual([
      { id: 'T-ANALYZED', camelot: '8A' },
      { id: 'T-CATALOG', camelot: '4A' }, // the catalog key now has one too
      { id: 'T-NOKEY', camelot: null },
      { id: 'T-SCALELESS', camelot: 'kept' },
    ]);
    db.close();
  });
});

describe('deriving Camelot on write', () => {
  it('gives a catalog key its position, with no analysis pass involved', () => {
    const cache = SelectaCache.open(':memory:');

    cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
    cache.saveAudioFeatures([
      featuresRow({ trackPersistentId: 'T-TEARDROP', musicalKey: 'F# minor', camelot: null }),
    ]);

    expect(cache.getAudioFeatures('T-TEARDROP')).toMatchObject({
      musicalKey: 'F# minor',
      camelot: '11A',
      // Derived, so it claims no provenance of its own.
      sources: { musicalKey: 'acousticbrainz' },
    });
    cache.close();
  });

  it('keeps the position pinned to the key that actually won the merge', () => {
    const cache = SelectaCache.open(':memory:');

    cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
    cache.saveAudioFeatures([
      featuresRow({ trackPersistentId: 'T-TEARDROP', musicalKey: 'C minor', camelot: null }),
    ]);
    // A later pass offering a different key is gap-filled away; the stored
    // position must follow the key that stayed, not the one that lost.
    cache.saveAudioFeatures([
      featuresRow({
        trackPersistentId: 'T-TEARDROP',
        musicalKey: 'E major',
        camelot: '12B',
        catalogStatus: null,
        analysisStatus: 'ok',
      }),
    ]);

    expect(cache.getAudioFeatures('T-TEARDROP')).toMatchObject({
      musicalKey: 'C minor',
      camelot: '5A',
    });
    cache.close();
  });
});
