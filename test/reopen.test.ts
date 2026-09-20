import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCliProgram } from '../src/cli.js';
import { SelectaCache } from '../src/cache/index.js';
import { reopenFeatures } from '../src/cache/audio_features.js';
import type { LibrarySnapshot } from '../src/types/bridge.js';
import fixture from './fixtures/library.json' with { type: 'json' };
import { featuresRow } from './helpers.js';
import { expectOnlyChanged, snapshotCache } from './table_diff.js';

const ANALYSIS_BPM = 'metrognome/onset-autocorrelation-comb@1';

/**
 * A library in the shape the real one is in after an analysis pass: a track
 * whose key was discarded as uncertain (tempo landed, so the attempt is
 * terminal and nothing names the missing key), and one the catalogs keyed.
 */
function seeded(): { dbPath: string } {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'selecta-reopen-')), 'library.db');
  const cache = SelectaCache.open(dbPath);

  cache.refreshFromSnapshot(fixture as LibrarySnapshot, { durationMs: 1 });
  cache.saveAudioFeatures([
    featuresRow({
      trackPersistentId: 'T-ANGEL',
      bpm: 132,
      musicalKey: null,
      camelot: null,
      danceability: null,
      sources: { bpm: ANALYSIS_BPM },
      catalogStatus: null,
      analysisStatus: 'ok',
    }),
    featuresRow({ analysisStatus: 'ok' }),
  ]);
  cache.close();

  return { dbPath };
}

function inspect<T>(dbPath: string, read: (cache: SelectaCache) => T): T {
  const cache = SelectaCache.open(dbPath);

  try {
    return read(cache);
  } finally {
    cache.close();
  }
}

async function run(dbPath: string, argv: string[]): Promise<any> {
  const writes: string[] = [];

  await createCliProgram({
    dbPath,
    logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    writeStdout: (text) => writes.push(text),
  }).parseAsync(['node', 'selecta', ...argv]);

  expect(writes).toHaveLength(1);

  return JSON.parse(writes[0]!);
}

function journals(dbPath: string): string[] {
  try {
    return readdirSync(join(dbPath, '..', 'undo'));
  } catch {
    return [];
  }
}

describe('reopening a discarded estimate', () => {
  it('clears the attempt for a track holding no value in the field', () => {
    const row = featuresRow({
      musicalKey: null,
      camelot: null,
      sources: { bpm: ANALYSIS_BPM },
      catalogStatus: 'ok',
      analysisStatus: 'ok',
    });
    const result = reopenFeatures(row, 'analysis', 'musicalKey');

    expect(result).toMatchObject({ action: 'update' });

    if (result.action !== 'update') throw new Error('expected an update');

    // The attempt goes; every value and the other source's record stay.
    expect(result.row).toMatchObject({
      analysisStatus: null,
      catalogStatus: 'ok',
      status: 'ok',
      bpm: row.bpm,
      danceability: row.danceability,
      sources: { bpm: ANALYSIS_BPM },
    });
  });

  it('leaves a track alone when the field already holds a value', () => {
    // Gap-fill means a fresh estimate would be discarded anyway, so whoever
    // supplied it, there is nothing to gain by trying again.
    const row = featuresRow({ analysisStatus: 'ok' });

    expect(reopenFeatures(row, 'analysis', 'musicalKey')).toEqual({ action: 'unchanged' });
  });

  it('leaves a track alone when that source never finished', () => {
    const row = featuresRow({ musicalKey: null, camelot: null, analysisStatus: null });

    expect(reopenFeatures(row, 'analysis', 'musicalKey')).toEqual({ action: 'unchanged' });
  });

  it('removes a row once it records no attempt and no value', () => {
    const row = featuresRow({
      bpm: null,
      musicalKey: null,
      camelot: null,
      danceability: null,
      sources: null,
      status: 'no_data',
      catalogStatus: null,
      analysisStatus: 'no_data',
    });

    expect(reopenFeatures(row, 'analysis', 'musicalKey')).toEqual({ action: 'delete' });
  });

  it('reports what it would reopen and writes nothing without --apply', async () => {
    const { dbPath } = seeded();
    const before = inspect(dbPath, (cache) => snapshotCache(cache.db));
    const json = await run(dbPath, ['reopen', '-m', 'musicalKey']);

    expect(json).toMatchObject({
      command: 'reopen',
      dry_run: true,
      undo_journal: null,
      summary: { tracks: 1, rows_removed: 0, by_status: { ok: 1 } },
    });

    expectOnlyChanged(
      before,
      inspect(dbPath, (cache) => snapshotCache(cache.db)),
      [],
    );
    expect(journals(dbPath)).toHaveLength(0);
  });

  it('reopens exactly the rows it reported and journals them', async () => {
    const { dbPath } = seeded();
    const before = inspect(dbPath, (cache) => snapshotCache(cache.db));
    const pendingBefore = inspect(dbPath, (cache) => cache.countPendingEnrichment('analysis'));
    const json = await run(dbPath, ['reopen', '-m', 'musicalKey', '--apply']);

    expect(json).toMatchObject({ dry_run: false, summary: { tracks: 1 } });
    expect(json.undo_journal).toMatch(/reopen-.*\.json$/);

    // The keyed track is untouched; only the one whose key was discarded moves.
    // Its row-level status follows the attempt it derives from, as it does
    // after a supersede — nothing queries that column, and the next run sets it.
    expectOnlyChanged(
      before,
      inspect(dbPath, (cache) => snapshotCache(cache.db)),
      [
        {
          table: 'audio_features',
          key: 'T-ANGEL',
          change: 'changed',
          fields: ['analysis_status', 'status'],
        },
      ],
    );
    expect(inspect(dbPath, (cache) => cache.countPendingEnrichment('analysis'))).toBe(
      pendingBefore + 1,
    );
  });

  it('puts the attempt back from its journal', async () => {
    const { dbPath } = seeded();
    const before = inspect(dbPath, (cache) => snapshotCache(cache.db));
    const { undo_journal: journal } = await run(dbPath, ['reopen', '-m', 'musicalKey', '--apply']);

    await run(dbPath, ['restore', journal, '--apply']);

    expectOnlyChanged(
      before,
      inspect(dbPath, (cache) => snapshotCache(cache.db)),
      [],
    );
  });
});
