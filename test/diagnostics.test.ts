import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCliProgram } from '../src/cli.js';
import { SelectaCache } from '../src/cache/index.js';
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
      database: { path: dbPath, exists: true, integrity: 'ok', errors: [] },
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
        attempted: 1,
        successful: 1,
        no_data: 0,
        no_match: 0,
        pending: snapshot.tracks.length - 1,
      },
    });
    expect(report.audio_features!.coverage.bpm.percent).toBeGreaterThan(0);
    expect(statSync(dbPath).mtimeMs).toBe(before.mtimeMs);
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
