import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import { withOperation } from '../src/operations/lock.js';
import { refreshLibrary } from '../src/operations/refresh.js';
import { handleSetLoved } from '../src/tools/set_loved.js';
import { createSources, withUserAgent } from '../src/enrich/sources.js';
import { featuresRow, makeToolDeps } from './helpers.js';
import fixture from './fixtures/library.json' with { type: 'json' };
import type { LibrarySnapshot } from '../src/types/bridge.js';

describe('operation lifecycle', () => {
  it('rejects a write during refresh, allows cache reads, and releases after failure', async () => {
    let fail!: (error: Error) => void;
    const readLibrary = vi.fn(
      () =>
        new Promise<LibrarySnapshot>((_, reject) => {
          fail = reject;
        }),
    );
    const setTrackLoved = vi
      .fn()
      .mockResolvedValue({ tracks: [{ persistentId: 'T-TEARDROP', loved: true }] });
    const deps = makeToolDeps({ readLibrary, setTrackLoved });
    try {
      const refresh = refreshLibrary(deps.cacheInstance, deps.bridge);
      expect(await handleSetLoved({ track_ids: ['T-TEARDROP'], loved: true }, deps)).toMatchObject({
        error: 'operation_busy',
      });
      expect(setTrackLoved).not.toHaveBeenCalled();
      expect(deps.cacheInstance.getTrack('T-TEARDROP')).not.toBeNull();
      fail(new Error('read failed'));
      await expect(refresh).rejects.toThrow('read failed');
      expect(await handleSetLoved({ track_ids: ['T-TEARDROP'], loved: true }, deps)).toMatchObject({
        updated: 1,
      });
    } finally {
      deps.cacheInstance.close();
    }
  });

  it('excludes another process against the same database and releases both lock kinds', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'selecta-lock-'));
    const cache = SelectaCache.open(join(directory, 'library.db'));
    try {
      for (const kind of ['music', 'enrich'] as const) {
        await withOperation(cache, kind, async () => {
          const script = `import { SelectaCache } from './dist/cache/index.js';
            import { withOperation } from './dist/operations/lock.js';
            const c = SelectaCache.open(${JSON.stringify(cache.db.name)});
            try { await withOperation(c, ${JSON.stringify(kind)}, async () => {}); process.exitCode = 1; }
            catch (e) { if (e.errorCode !== 'operation_busy') throw e; }
            finally { c.close(); }`;
          expect(() =>
            execFileSync(process.execPath, ['--input-type=module', '-e', script]),
          ).not.toThrow();
        });
        await expect(withOperation(cache, kind, async () => 'released')).resolves.toBe('released');
      }
    } finally {
      cache.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('does not resurrect enrichment rows for tracks removed during lookup', () => {
    const cache = SelectaCache.open(':memory:');
    try {
      cache.refreshFromSnapshot(fixture as LibrarySnapshot, { durationMs: 1 });
      cache.refreshFromSnapshot({ ...fixture, tracks: [] } as LibrarySnapshot, { durationMs: 1 });
      cache.saveAudioFeatures([featuresRow()]);
      expect(cache.getAudioFeatures('T-TEARDROP')).toBeNull();
    } finally {
      cache.close();
    }
  });

  it.each(['60', 'Thu, 01 Jan 1970 00:01:02 GMT'])(
    'honors Retry-After %s without reissuing the failed request',
    async (header) => {
      let time = 0;
      const calls: number[] = [];
      const fetchLike = vi.fn(async () => {
        calls.push(time);
        return calls.length === 1
          ? { ok: false, status: 503, headers: { get: () => header }, json: async () => ({}) }
          : { ok: true, status: 200, json: async () => ({ recordings: [] }) };
      });
      const sources = createSources({
        fetchLike,
        nowMs: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      });
      await expect(
        sources.mbFindRecording({ artist: 'A', title: 'first', durationSeconds: null }),
      ).rejects.toMatchObject({ errorCode: 'enrichment_error' });
      await sources.mbFindRecording({ artist: 'A', title: 'second', durationSeconds: null });
      expect(calls).toHaveLength(2);
      expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(60_000);
      expect(fetchLike.mock.calls).toHaveLength(2);
    },
  );

  it('applies an abort deadline to production fetch including response body reads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'));
    await withUserAgent(fetchImpl)('https://example.invalid');
    expect(fetchImpl.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });
});
