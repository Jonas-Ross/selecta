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

  it('projects the backlog it will leave, not the one it is replacing', async () => {
    const { dbPath } = seeded();
    const pendingBefore = inspect(dbPath, (cache) => cache.countPendingEnrichment('analysis'));
    const dry = await run(dbPath, ['reopen', '-m', 'musicalKey']);
    const applied = await run(dbPath, ['reopen', '-m', 'musicalKey', '--apply']);

    // Pinned against a number computed here, not just against each other: two
    // runs agreeing proves nothing when both can be wrong the same way, and an
    // undefined key compares equal to itself.
    expect(typeof dry.pending_remaining).toBe('number');
    expect(dry.pending_remaining).toBe(pendingBefore + dry.summary.tracks);
    expect(applied.pending_remaining).toBe(dry.pending_remaining);
  });

  it('skips a track pruned between deciding and writing', () => {
    const cache = SelectaCache.open(':memory:');

    try {
      const snapshot = fixture as LibrarySnapshot;

      cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
      cache.saveAudioFeatures([
        featuresRow({ musicalKey: null, camelot: null, analysisStatus: 'ok' }),
      ]);

      const plan = cache.planReopenFeatures('analysis', 'musicalKey');

      // reopen holds the enrich lock, refresh holds the music one, so this
      // interleaving is reachable. The row is already gone; rewriting it would
      // resurrect an orphan, and reporting it would overstate what moved.
      cache.refreshFromSnapshot(
        { ...snapshot, tracks: snapshot.tracks.filter((t) => t.persistentId !== 'T-TEARDROP') },
        { durationMs: 1 },
      );

      expect(cache.applyReopenFeatures(plan)).toMatchObject({ tracks: 0 });
      expect(cache.getAudioFeatures('T-TEARDROP')).toBeNull();
    } finally {
      cache.close();
    }
  });

  it('refuses a field the named source cannot measure', async () => {
    const { dbPath } = seeded();
    const before = inspect(dbPath, (cache) => snapshotCache(cache.db));
    const writes: string[] = [];
    const logged: string[] = [];
    let exitCode: number | undefined;

    await createCliProgram({
      dbPath,
      logger: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn((...parts: unknown[]) => logged.push(parts.join(' '))),
      },
      writeStdout: (text) => writes.push(text),
      setExitCode: (code) => (exitCode = code),
    }).parseAsync(['node', 'selecta', 'reopen', '-s', 'analysis', '-m', 'danceability']);

    // metrognome measures tempo and key only, so this would reopen the whole
    // analysed library, fill nothing, and mark it terminal again.
    expect(exitCode).toBe(1);
    expect(writes).toHaveLength(0);
    expect(logged.join('\n')).toContain('analysis does not measure danceability');
    expectOnlyChanged(
      before,
      inspect(dbPath, (cache) => snapshotCache(cache.db)),
      [],
    );
  });

  it('allows a field the source does measure', async () => {
    const { dbPath } = seeded();
    const json = await run(dbPath, ['reopen', '-s', 'catalog', '-m', 'danceability']);

    expect(json).toMatchObject({ command: 'reopen', dry_run: true });
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
