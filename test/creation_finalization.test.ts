import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { handleCreatePlaylist } from '../src/tools/create_playlist.js';
import { PlaylistDraftTools } from '../src/tools/playlist_draft.js';
import { DraftStore } from '../src/drafts/store.js';
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

it.each([
  { outcome: 'partial', expectedStatus: 'write_uncertain' },
  { outcome: 'rejected', expectedStatus: 'rejected_before_write' },
  { outcome: 'success', expectedStatus: 'committed_cleanup_failed' },
] as const)(
  'retains the settled $outcome outcome when removing the file lock fails',
  async ({ outcome, expectedStatus }) => {
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
      status: expectedStatus,
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

function failCleanup() {
  vi.mocked(rmSync).mockImplementationOnce(() => {
    throw new Error('cleanup cause: permission denied');
  });
}

const observedIds = ['T-ROADS', 'T-TEARDROP', 'T-TEARDROP'];

function successfulBridge() {
  return makeBridge({
    createPlaylist: vi.fn().mockResolvedValue({
      persistentId: 'P-COMMITTED',
      trackCount: 3,
      trackPersistentIds: observedIds,
    }),
  });
}

it('returns committed creation facts and note with the canonical stale-lock recovery path', async () => {
  const bridge = successfulBridge();

  failCleanup();
  const result = await handleCreatePlaylist(
    { name: 'Mix', track_ids: ids, note: 'approved arc' },
    { cache: () => cache, bridge },
  );
  const lockPath = `${realpathSync(cache.db.name)}.music.lock`;

  expect(result).toMatchObject({
    error: 'operation_cleanup_failed',
    creation_committed: true,
    playlist_id: 'P-COMMITTED',
    name: 'Mix',
    track_count: 3,
    order_matches_request: false,
    note: { body: 'approved arc' },
    lock_path: lockPath,
    partial_write: { playlist_id: 'P-COMMITTED', observed_track_ids: observedIds },
  });
  expect(result).toHaveProperty(
    'hint',
    expect.stringContaining('Creation committed to Music.app and the cache'),
  );
  expect(result).toHaveProperty('hint', expect.stringContaining(lockPath));
  expect(result).toHaveProperty('hint', expect.stringContaining('Stop all Selecta processes'));
  expect(result).toHaveProperty(
    'hint',
    expect.stringContaining("Never remove a live owner's lock"),
  );
  expect(result).toHaveProperty(
    'hint',
    expect.stringContaining('No refresh or repeat creation is needed'),
  );
  expect(cache.getPlaylistTrackIds('P-COMMITTED')).toEqual(observedIds);
  expect(cache.getCreationName('P-COMMITTED')).toBe('Mix');
  expect(cache.getNote('playlist', 'P-COMMITTED')?.body).toBe('approved arc');
  expect(bridge.createPlaylist).toHaveBeenCalledTimes(1);
});

it('preserves the original persistence cause as well as the cleanup cause and target', async () => {
  const bridge = successfulBridge();

  cache.db.exec(
    "CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON playlist_creations BEGIN SELECT RAISE(ABORT, 'persistence cause: disk full'); END",
  );
  failCleanup();
  const result = await handleCreatePlaylist(
    { name: 'Mix', track_ids: ids, note: 'uncommitted note' },
    { cache: () => cache, bridge },
  );

  expect(result).toMatchObject({
    error: 'cache_unavailable',
    lock_path: `${realpathSync(cache.db.name)}.music.lock`,
    partial_write: { playlist_id: 'P-COMMITTED', observed_track_ids: observedIds },
  });
  expect(result).toHaveProperty('hint', expect.stringContaining('persistence cause: disk full'));
  expect(result).toHaveProperty(
    'hint',
    expect.stringContaining('cleanup cause: permission denied'),
  );
  expect(result).not.toHaveProperty('creation_committed');
  expect(result).not.toHaveProperty('note');
  expect(cache.getPlaylist('P-COMMITTED')).toBeNull();
  expect(cache.getNote('playlist', 'P-COMMITTED')).toBeNull();
  expect(cache.getCreationName('P-COMMITTED')).toBeNull();
  expect(bridge.createPlaylist).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  'retains committed facts across draft recovery when receipt failure is %s',
  async (receiptFails) => {
    const bridge = successfulBridge();
    const store = new DraftStore(join(dir, 'drafts.db'));
    const deps = { cache: () => cache, bridge, drafts: () => store };
    const tools = new PlaylistDraftTools(deps);
    const draftId = randomUUID();

    await tools.show({ draft_id: draftId, name: 'Mix', track_ids: ids });

    if (receiptFails) {
      const update = store.update.bind(store);

      vi.spyOn(store, 'update').mockImplementation((id, revision, change) => {
        if (revision === 2) throw new BridgeError('cache_unavailable', 'draft receipt cause');

        return update(id, revision, change);
      });
    }

    failCleanup();
    const result = await tools.save({ draft_id: draftId, revision: 1 });
    const expected = {
      error: 'operation_cleanup_failed',
      creation_committed: true,
      playlist_id: 'P-COMMITTED',
      track_count: 3,
      lock_path: `${realpathSync(cache.db.name)}.music.lock`,
      partial_write: { playlist_id: 'P-COMMITTED', observed_track_ids: observedIds },
    };

    expect(result).toMatchObject({ result: expected });
    const reopened = new DraftStore(store.path).get(draftId);

    if (receiptFails) expect(reopened.save?.status).toBe('pending');
    else expect(reopened.save).toMatchObject({ status: 'finished', result: expected });

    const recoveredTools = new PlaylistDraftTools({
      ...deps,
      drafts: () => new DraftStore(store.path),
    });

    expect(
      await recoveredTools.save({ draft_id: draftId, revision: reopened.revision }),
    ).toMatchObject({ error: 'validation_error' });
    expect(cache.getPlaylistTrackIds('P-COMMITTED')).toEqual(observedIds);
    expect(bridge.createPlaylist).toHaveBeenCalledTimes(1);
  },
);
