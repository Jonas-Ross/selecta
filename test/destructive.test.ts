import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCliProgram } from '../src/cli.js';
import { readUndoJournal, runDestructive } from '../src/operations/destructive.js';
import { planRestore } from '../src/operations/restore.js';
import { SelectaCache } from '../src/cache/index.js';
import type { LibrarySnapshot } from '../src/types/bridge.js';
import fixture from './fixtures/library.json' with { type: 'json' };
import { featuresRow } from './helpers.js';
import { expectOnlyChanged, snapshotCache } from './table_diff.js';

const ANALYSIS_KEY = 'metrognome/chroma-correlation-edm@1';
const ANALYSIS_BPM = 'metrognome/onset-autocorrelation-comb@1';

function seeded(): { dbPath: string } {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'selecta-destructive-')), 'library.db');
  const cache = SelectaCache.open(dbPath);

  cache.refreshFromSnapshot(fixture as LibrarySnapshot, { durationMs: 1 });
  cache.saveAudioFeatures([
    featuresRow({ sources: { bpm: 'deezer', musicalKey: ANALYSIS_KEY }, analysisStatus: 'ok' }),
    featuresRow({
      trackPersistentId: 'T-ANGEL',
      bpm: 132,
      musicalKey: null,
      camelot: null,
      danceability: null,
      sources: { bpm: ANALYSIS_KEY },
      catalogStatus: null,
      analysisStatus: 'ok',
    }),
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

async function invoke(
  dbPath: string,
  argv: string[],
): Promise<{ writes: string[]; logged: string[]; exitCode?: number }> {
  const writes: string[] = [];
  const logged: string[] = [];
  const record = (...parts: unknown[]): number => logged.push(parts.join(' '));
  let exitCode: number | undefined;

  await createCliProgram({
    dbPath,
    logger: { info: vi.fn(record), debug: vi.fn(), error: vi.fn(record) },
    writeStdout: (text) => writes.push(text),
    setExitCode: (code) => (exitCode = code),
  }).parseAsync(['node', 'selecta', ...argv]);

  return { writes, logged, exitCode };
}

async function run(dbPath: string, argv: string[]): Promise<{ json: any; logged: string[] }> {
  const { writes, logged } = await invoke(dbPath, argv);

  expect(writes).toHaveLength(1);

  return { json: JSON.parse(writes[0]!), logged };
}

/** A refused run: stdout stays empty, the reason goes to the log. */
async function refused(dbPath: string, argv: string[]): Promise<string> {
  const { writes, logged, exitCode } = await invoke(dbPath, argv);

  expect(writes).toHaveLength(0);
  expect(exitCode).toBe(1);

  return logged.join('\n');
}

function journals(dbPath: string): string[] {
  const directory = join(dbPath, '..', 'undo');

  try {
    return readdirSync(directory).map((name) => join(directory, name));
  } catch {
    return [];
  }
}

describe('destructive CLI commands', () => {
  it('reports what supersede would clear and writes nothing without --apply', async () => {
    const { dbPath } = seeded();
    const before = inspect(dbPath, (cache) => snapshotCache(cache.db));
    const { json, logged } = await run(dbPath, ['supersede', '-p', ANALYSIS_KEY]);

    expect(json).toMatchObject({
      command: 'supersede',
      dry_run: true,
      undo_journal: null,
      summary: {
        tracks: 2,
        cleared_fields: { bpm: 1, musicalKey: 1 },
        rows_removed: 1,
        by_provenance: { [ANALYSIS_KEY]: { bpm: 1, musicalKey: 1 } },
      },
    });
    expect(logged.join('\n')).toContain('--apply');
    expectOnlyChanged(
      before,
      inspect(dbPath, (cache) => snapshotCache(cache.db)),
      [],
    );
    expect(journals(dbPath)).toHaveLength(0);
  });

  it('clears exactly what the dry run described, and journals it', async () => {
    const { dbPath } = seeded();
    const dry = await run(dbPath, ['supersede', '-p', ANALYSIS_KEY]);
    const before = inspect(dbPath, (cache) => snapshotCache(cache.db));
    const { json } = await run(dbPath, ['supersede', '-p', ANALYSIS_KEY, '--apply']);

    // The dry run is a promise about the apply, so the summaries must agree.
    expect(json.summary).toEqual(dry.json.summary);
    expect(json.dry_run).toBe(false);
    expectOnlyChanged(
      before,
      inspect(dbPath, (cache) => snapshotCache(cache.db)),
      [
        {
          table: 'audio_features',
          key: 'T-TEARDROP',
          change: 'changed',
          fields: ['analysis_status', 'camelot', 'musical_key', 'sources'],
        },
        { table: 'audio_features', key: 'T-ANGEL', change: 'removed' },
      ],
    );

    const journal = JSON.parse(readFileSync(json.undo_journal, 'utf8'));

    expect(journal).toMatchObject({
      journal_version: 1,
      command: 'supersede',
      arguments: { source: 'analysis', provenance: [ANALYSIS_KEY] },
    });
    expect(journal.rows.audio_features).toHaveLength(2);
  });

  it('puts the cache back byte for byte when the journal is restored', async () => {
    const { dbPath } = seeded();
    const before = inspect(dbPath, (cache) => snapshotCache(cache.db));
    const superseded = await run(dbPath, ['supersede', '-p', ANALYSIS_KEY, '--apply']);

    const dry = await run(dbPath, ['restore', superseded.json.undo_journal]);

    expect(dry.json).toMatchObject({
      command: 'restore',
      dry_run: true,
      summary: { rows: 2, replacing: 1, adding: 1 },
    });

    const { json } = await run(dbPath, ['restore', superseded.json.undo_journal, '--apply']);

    expect(json.dry_run).toBe(false);
    expectOnlyChanged(
      before,
      inspect(dbPath, (cache) => snapshotCache(cache.db)),
      [],
    );
  });

  it('refuses a journal written for another database', async () => {
    const { dbPath } = seeded();
    const { dbPath: otherPath } = seeded();
    const superseded = await run(dbPath, ['supersede', '-p', ANALYSIS_KEY, '--apply']);
    const before = inspect(otherPath, (cache) => snapshotCache(cache.db));

    expect(
      await refused(otherPath, ['restore', superseded.json.undo_journal, '--apply']),
    ).toContain('was written for');
    expectOnlyChanged(
      before,
      inspect(otherPath, (cache) => snapshotCache(cache.db)),
      [],
    );
  });

  it('refuses a journal carrying a table it cannot restore', async () => {
    const { dbPath } = seeded();
    const superseded = await run(dbPath, ['supersede', '-p', ANALYSIS_KEY, '--apply']);
    const journal = JSON.parse(readFileSync(superseded.json.undo_journal, 'utf8'));

    journal.rows.playlists = [{ persistent_id: 'P-1' }];
    writeFileSync(superseded.json.undo_journal, JSON.stringify(journal), 'utf8');

    const before = inspect(dbPath, (cache) => snapshotCache(cache.db));

    expect(await refused(dbPath, ['restore', superseded.json.undo_journal, '--apply'])).toContain(
      'cannot restore',
    );
    expectOnlyChanged(
      before,
      inspect(dbPath, (cache) => snapshotCache(cache.db)),
      [],
    );
  });

  it('skips a journalled row whose track has since left the library', async () => {
    const { dbPath } = seeded();
    const superseded = await run(dbPath, ['supersede', '-p', ANALYSIS_KEY, '--apply']);
    const snapshot = fixture as LibrarySnapshot;
    const withoutAngel = {
      ...snapshot,
      tracks: snapshot.tracks.filter((track) => track.persistentId !== 'T-ANGEL'),
    };
    const reread = SelectaCache.open(dbPath);

    reread.refreshFromSnapshot(withoutAngel, { durationMs: 1 });
    reread.close();

    const { json } = await run(dbPath, ['restore', superseded.json.undo_journal, '--apply']);

    // Re-adding features for a track that is gone would orphan the row until
    // the next refresh pruned it again.
    expect(json.summary).toMatchObject({ rows: 1, skipped: 1 });
    expect(inspect(dbPath, (cache) => cache.getAudioFeatures('T-ANGEL'))).toBeNull();
    expect(inspect(dbPath, (cache) => cache.getAudioFeatures('T-TEARDROP'))).toMatchObject({
      musicalKey: 'A minor',
    });
  });

  it('refuses a provenance no stored feature came from', async () => {
    const { dbPath } = seeded();
    const before = inspect(dbPath, (cache) => snapshotCache(cache.db));

    // One character off the real string. Reporting "0 tracks" and exiting 0
    // would be indistinguishable from an algorithm already superseded.
    const logged = await refused(dbPath, ['supersede', '-p', 'metrognome/chroma@9', '--apply']);

    expect(logged).toContain('no stored feature came from');
    expect(logged).toContain('--provenance');
    expectOnlyChanged(
      before,
      inspect(dbPath, (cache) => snapshotCache(cache.db)),
      [],
    );
    expect(journals(dbPath)).toHaveLength(0);
  });

  it('predicts the backlog the apply actually leaves', async () => {
    const { dbPath } = seeded();
    const dry = await run(dbPath, ['supersede', '-p', ANALYSIS_KEY]);
    const applied = await run(dbPath, ['supersede', '-p', ANALYSIS_KEY, '--apply']);
    // Ground truth from the cache, not from either run's own arithmetic.
    const backlog = inspect(dbPath, (cache) => cache.countPendingEnrichment('analysis'));

    // Named because a key the CLI does not emit reads as undefined on both
    // sides and compares equal, which is how this assertion once passed while
    // the projection was wrong.
    expect(typeof dry.json.pending_remaining).toBe('number');
    expect(dry.json.pending_remaining).toBe(backlog);
    expect(applied.json.pending_remaining).toBe(backlog);
  });

  it('does not count a track the backlog already holds', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'selecta-destructive-')), 'library.db');
    const cache = SelectaCache.open(dbPath);

    cache.refreshFromSnapshot(fixture as LibrarySnapshot, { durationMs: 1 });
    cache.saveAudioFeatures([
      featuresRow({
        sources: { bpm: ANALYSIS_BPM, musicalKey: ANALYSIS_KEY },
        catalogStatus: null,
        analysisStatus: 'ok',
      }),
    ]);
    cache.close();

    // Clearing one of the two algorithms already reopened this track, so the
    // second supersede changes a row that is pending again — adding it to the
    // backlog a second time would predict a number the apply never reaches.
    await run(dbPath, ['supersede', '-p', ANALYSIS_KEY, '--apply']);

    const dry = await run(dbPath, ['supersede', '-p', ANALYSIS_BPM]);

    await run(dbPath, ['supersede', '-p', ANALYSIS_BPM, '--apply']);

    expect(dry.json.pending_remaining).toBe(
      inspect(dbPath, (open) => open.countPendingEnrichment('analysis')),
    );
  });

  it('writes no journal for a change that moves nothing', () => {
    const { dbPath } = seeded();
    const outcome = runDestructive(
      {
        command: 'supersede',
        arguments: {},
        summary: { tracks: 0 },
        empty: true,
        before: { audio_features: [] },
        apply: () => {
          throw new Error('an empty change must not be applied');
        },
      },
      { apply: true, dbPath },
    );

    expect(outcome).toMatchObject({ dry_run: false, undo_journal: null });
    expect(journals(dbPath)).toHaveLength(0);
  });

  it('reports what a restore actually put back, not what it planned to', async () => {
    const { dbPath } = seeded();
    const superseded = await run(dbPath, ['supersede', '-p', ANALYSIS_KEY, '--apply']);
    const cache = SelectaCache.open(dbPath);

    try {
      const plan = planRestore(cache, readUndoJournal(superseded.json.undo_journal, dbPath));

      expect(plan.summary).toMatchObject({ rows: 2, skipped: 0 });

      // The same plan-then-write interleaving applySupersedeFeatures guards
      // against: a refresh prunes one of the tracks before the write lands.
      const snapshot = fixture as LibrarySnapshot;

      cache.refreshFromSnapshot(
        { ...snapshot, tracks: snapshot.tracks.filter((t) => t.persistentId !== 'T-ANGEL') },
        { durationMs: 1 },
      );

      expect(plan.apply()).toMatchObject({ rows: 1, replacing: 1, adding: 0, skipped: 1 });
    } finally {
      cache.close();
    }
  });

  it('refuses a journal whose rows are not a list', async () => {
    const { dbPath } = seeded();
    const superseded = await run(dbPath, ['supersede', '-p', ANALYSIS_KEY, '--apply']);
    const journal = JSON.parse(readFileSync(superseded.json.undo_journal, 'utf8'));

    journal.rows.audio_features = { trackPersistentId: 'T-TEARDROP' };
    writeFileSync(superseded.json.undo_journal, JSON.stringify(journal), 'utf8');

    expect(await refused(dbPath, ['restore', superseded.json.undo_journal, '--apply'])).toContain(
      'other than a list of rows',
    );
  });

  it('survives a feature row whose provenance is not valid JSON', async () => {
    const { dbPath } = seeded();
    const cache = SelectaCache.open(dbPath);

    cache.db
      .prepare("UPDATE audio_features SET sources = '{not json' WHERE track_persistent_id = ?")
      .run('T-ANGEL');
    cache.close();

    // The survey is the read-only half of a destructive command; one hand-edited
    // row must not be able to take it down.
    const { json } = await run(dbPath, ['supersede']);

    expect(json.provenance).toEqual(
      expect.arrayContaining([{ field: 'musicalKey', provenance: ANALYSIS_KEY, trackCount: 1 }]),
    );
  });
});
