import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCliProgram } from '../src/cli.js';
import { SelectaCache } from '../src/cache/index.js';
import { LATEST_SCHEMA_VERSION } from '../src/cache/migrations.js';
import { runDoctor } from '../src/diagnostics/doctor.js';
import {
  formatReconciliationSummary,
  readStatus,
  type ReconciliationSummary,
} from '../src/diagnostics/status.js';
import type { LibrarySnapshot } from '../src/types/bridge.js';
import { BridgeError } from '../src/types/errors.js';
import fixture from './fixtures/library.json' with { type: 'json' };
import { featuresRow } from './helpers.js';

const snapshot = fixture as LibrarySnapshot;

function seededDatabase(): { dbPath: string; refreshedAt: string } {
  const directory = mkdtempSync(join(tmpdir(), 'selecta-diagnostics-'));
  const dbPath = join(directory, 'library.db');
  const cache = SelectaCache.open(dbPath);
  const { refreshedAt } = cache.refreshFromSnapshot(snapshot, { durationMs: 42 });

  cache.saveAudioFeatures([featuresRow()]);
  const summary: ReconciliationSummary = { rekeys: 1, duplicates_removed: 2, failures: 0 };

  cache.appendRefreshNote(refreshedAt, formatReconciliationSummary(summary));
  cache.close();

  return { dbPath, refreshedAt };
}

describe('readStatus', () => {
  it('reports cache health and enrichment coverage without changing the database', () => {
    const { dbPath, refreshedAt } = seededDatabase();
    const before = statSync(dbPath);

    const report = readStatus(dbPath, new Date(Date.parse(refreshedAt) + 3_600_000));

    expect(report).toMatchObject({
      ok: true,
      database: {
        path: dbPath,
        exists: true,
        integrity: 'ok',
        schema: {
          version: LATEST_SCHEMA_VERSION,
          expected: LATEST_SCHEMA_VERSION,
          pending: 0,
        },
        errors: [],
      },
      cache: {
        age_hours: 1,
        track_count: snapshot.tracks.length,
        playlist_count: snapshot.playlists.length,
        last_refresh: { refreshed_at: refreshedAt, duration_ms: 42 },
        last_reconciliation: {
          refreshed_at: refreshedAt,
          summary: { rekeys: 1, duplicates_removed: 2, failures: 0 },
        },
      },
      audio_features: {
        sources: {
          catalog: {
            attempted: 1,
            successful: 1,
            no_data: 0,
            no_match: 0,
            pending: snapshot.tracks.length - 1,
          },
          // Nothing has been analyzed, so every track is pending that source.
          analysis: {
            attempted: 0,
            successful: 0,
            no_data: 0,
            no_match: 0,
            pending: snapshot.tracks.length,
          },
        },
      },
    });
    expect(report.audio_features!.coverage.bpm.percent).toBeGreaterThan(0);
    expect(statSync(dbPath).mtimeMs).toBe(before.mtimeMs);
  });

  it('keeps counting a value analysis owns after a failed retry re-records its attempt', () => {
    const { dbPath } = seededDatabase();
    const cache = SelectaCache.open(dbPath);
    const analysisKey = 'metrognome/key-profile@1';

    cache.saveAudioFeatures([
      featuresRow({
        trackPersistentId: 'T-ANGEL',
        mbRecordingMbid: null,
        deezerTrackId: null,
        bpm: 132,
        musicalKey: 'F minor',
        danceability: null,
        sources: { bpm: 'metrognome/onset-autocorrelation-comb@1', musicalKey: analysisKey },
        catalogStatus: null,
        analysisStatus: 'ok',
      }),
    ]);
    cache.applySupersedeFeatures(cache.planSupersedeFeatures('analysis', [analysisKey]));
    // The retry finds nothing; merge keeps the bpm and records the attempt.
    cache.saveAudioFeatures([
      featuresRow({
        trackPersistentId: 'T-ANGEL',
        bpm: null,
        musicalKey: null,
        camelot: null,
        danceability: null,
        sources: null,
        mbRecordingMbid: null,
        deezerTrackId: null,
        status: 'no_match',
        catalogStatus: null,
        analysisStatus: 'no_match',
      }),
    ]);
    cache.close();

    const { analysis, catalog } = readStatus(dbPath).audio_features!.sources;

    // The attempt outcome stays accurate: this retry did fail.
    expect(analysis).toMatchObject({ attempted: 1, successful: 0, no_match: 1 });
    expect(analysis.owns).toEqual({ bpm: 1, musical_key: 0, danceability: 0 });
    expect(catalog.owns).toEqual({ bpm: 1, musical_key: 1, danceability: 1 });
  });

  it('reads historical nonzero removal and failure counts without rewriting stored data', () => {
    const { dbPath, refreshedAt } = seededDatabase();
    const cache = SelectaCache.open(dbPath);
    const historical =
      'legacy refresh; sync_reconciliation={"rekeys":1,"duplicates_removed":3,"failures":2}; retained note';

    cache.db
      .prepare('UPDATE refresh_log SET notes = ? WHERE refreshed_at = ?')
      .run(historical, refreshedAt);
    cache.close();
    const before = readFileSync(dbPath);
    const report = readStatus(dbPath);

    expect(report.cache!.last_reconciliation).toEqual({
      refreshed_at: refreshedAt,
      summary: { rekeys: 1, duplicates_removed: 3, failures: 2 },
    });
    expect(report.cache!.last_refresh!.notes).toBe(historical);
    expect(readFileSync(dbPath)).toEqual(before);
  });

  it('reports a missing cache without creating a file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'selecta-status-missing-'));
    const dbPath = join(directory, 'missing.db');

    expect(readStatus(dbPath)).toMatchObject({
      ok: false,
      database: { exists: false, integrity: 'unavailable' },
      cache: null,
      audio_features: null,
    });
    expect(readdirSync(directory)).toEqual([]);
  });
});

describe('doctor diagnostics', () => {
  it.each([
    ['music_app_not_running', false, null],
    ['automation_permission_denied', true, false],
    ['jxa_error', null, null],
  ] as const)('maps %s without retrying', async (code, running, authorized) => {
    const { dbPath } = seededDatabase();
    const check = vi.fn().mockRejectedValue(new BridgeError(code, 'probe failed'));

    const result = await runDoctor(dbPath, check);

    expect(check).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      music_app: { status: code, running, automation_authorized: authorized },
    });
  });
});

describe('diagnostic CLI commands', () => {
  it('writes exactly one JSON status result and sends no Apple event', async () => {
    const { dbPath } = seededDatabase();
    const writes: string[] = [];
    const musicCheck = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    let exitCode: number | undefined;

    await createCliProgram({
      dbPath,
      logger,
      musicCheck,
      setExitCode: (code) => (exitCode = code),
      writeStdout: (text) => writes.push(text),
    }).parseAsync(['node', 'selecta', 'status']);

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toMatchObject({ ok: true, database: { path: dbPath } });
    expect(musicCheck).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(exitCode).toBeUndefined();
  });

  it('names the pending migrations behind a stale count, without failing the run', async () => {
    const { dbPath } = seededDatabase();
    const cache = SelectaCache.open(dbPath);

    // What a build one version back leaves on disk; diagnostics never migrate.
    cache.db.pragma(`user_version = ${LATEST_SCHEMA_VERSION - 1}`);
    cache.close();
    const writes: string[] = [];
    const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    let exitCode: number | undefined;

    await createCliProgram({
      dbPath,
      logger,
      musicCheck: vi.fn(),
      setExitCode: (code) => (exitCode = code),
      writeStdout: (text) => writes.push(text),
    }).parseAsync(['node', 'selecta', 'status']);

    expect(JSON.parse(writes[0]!).database.schema).toEqual({
      version: LATEST_SCHEMA_VERSION - 1,
      expected: LATEST_SCHEMA_VERSION,
      pending: 1,
    });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('1 pending migration'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('refresh'));
    expect(exitCode).toBeUndefined();
  });

  it('writes one doctor result and keeps diagnostic errors on stderr logging', async () => {
    const { dbPath } = seededDatabase();
    const writes: string[] = [];
    const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    let exitCode: number | undefined;

    await createCliProgram({
      dbPath,
      logger,
      musicCheck: vi
        .fn()
        .mockRejectedValue(new BridgeError('automation_permission_denied', 'denied')),
      setExitCode: (code) => (exitCode = code),
      writeStdout: (text) => writes.push(text),
    }).parseAsync(['node', 'selecta', 'doctor']);

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!).music_app.status).toBe('automation_permission_denied');
    expect(logger.error).toHaveBeenCalledWith('[automation_permission_denied] denied');
    expect(exitCode).toBe(1);
  });
});
