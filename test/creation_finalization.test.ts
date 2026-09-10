import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelectaCache } from '../src/cache/index.js';
import { createPlaylist } from '../src/operations/create_playlist.js';
import { BridgeError } from '../src/types/errors.js';
import type { LibrarySnapshot } from '../src/types/bridge.js';
import { makeBridge } from './helpers.js';
import fixture from './fixtures/library.json' with { type: 'json' };

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();

  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});

let dir: string;
let cache: SelectaCache;
const ids = ['T-TEARDROP', 'T-ROADS', 'T-TEARDROP'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'selecta-creation-finalization-'));
  cache = SelectaCache.open(join(dir, 'library.db'));
  cache.refreshFromSnapshot(fixture as LibrarySnapshot, { durationMs: 1 });
});
afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

it.each(['partial', 'rejected', 'success'] as const)(
  'retains the settled %s outcome when removing the file lock fails',
  async (outcome) => {
    const bridge = makeBridge({
      createPlaylist: vi.fn().mockImplementation(async () => {
        expect(cache.db.inTransaction).toBe(false);

        if (outcome === 'partial')
          throw new BridgeError('jxa_error', 'population failed', undefined, {
            playlist_id: 'P-KNOWN',
            observed_track_ids: ids,
          });

        if (outcome === 'rejected')
          throw new BridgeError(
            'track_not_found',
            'validated guard',
            undefined,
            undefined,
            'not_started',
          );

        return { persistentId: 'P-KNOWN', trackCount: ids.length, trackPersistentIds: ids };
      }),
    });

    vi.mocked(rmSync).mockImplementationOnce(() => {
      throw new Error('cannot remove lock');
    });
    const deps = { cache: () => cache, bridge };
    const result = await createPlaylist({ name: 'Mix', trackIds: ids }, deps);

    expect(result).toMatchObject({
      status:
        outcome === 'success'
          ? 'persistence_failed'
          : outcome === 'partial'
            ? 'write_uncertain'
            : 'rejected_before_write',
      error: { hint: expect.stringContaining('cannot remove lock') },
    });

    if (outcome !== 'rejected')
      expect(result).toMatchObject({
        error: { partial_write: { playlist_id: 'P-KNOWN', observed_track_ids: ids } },
      });

    expect(cache.getPlaylist('P-KNOWN') !== null).toBe(outcome === 'success');
    expect(existsSync(`${cache.db.name}.music.lock`)).toBe(true);
    expect(await createPlaylist({ name: 'Another', trackIds: ids }, deps)).toMatchObject({
      status: 'rejected_before_write',
      error: { error: 'operation_busy' },
    });
    expect(bridge.createPlaylist).toHaveBeenCalledTimes(1);
  },
);
