import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlaylist } from '../src/operations/create_playlist.js';
import { withOperation } from '../src/operations/lock.js';
import { PREVIEW_PLAYLIST_NAME } from '../src/operations/playlist.js';
import { BridgeError } from '../src/types/errors.js';
import { handleCreatePlaylist } from '../src/tools/create_playlist.js';
import { makeToolDeps } from './helpers.js';

let deps: ReturnType<typeof makeToolDeps>;
const requested = ['T-TEARDROP', 'T-ROADS', 'T-TEARDROP'];
const observed = ['T-ROADS', 'T-TEARDROP', 'T-TEARDROP'];
const destination = {
  persistentId: 'P-NEW',
  trackCount: observed.length,
  trackPersistentIds: observed,
};

beforeEach(() => {
  deps = makeToolDeps({ createPlaylist: vi.fn().mockResolvedValue(destination) });
});
afterEach(() => deps.cacheInstance.close());

function localState() {
  return Object.fromEntries(
    ['playlists', 'playlist_tracks', 'playlist_creations', 'notes'].map((table) => [
      table,
      deps.cacheInstance.db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all(),
    ]),
  );
}

// Real SQLite triggers fail statements inside the transaction, rather than
// replacing the method whose rollback guarantees are under test.
function failStatement(trigger: string) {
  deps.cacheInstance.db.exec(
    `CREATE TEMP TRIGGER injected_failure ${trigger} BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END`,
  );
}

describe('creation outcomes', () => {
  it('rejects missing tracks and cache failures before attempting Music.app', async () => {
    expect(await createPlaylist({ name: 'Mix', trackIds: ['missing'] }, deps)).toMatchObject({
      status: 'rejected_before_write',
      error: { error: 'track_not_found' },
    });
    expect(
      await createPlaylist(
        { name: 'Mix', trackIds: requested },
        {
          ...deps,
          cache: () => {
            throw new Error('cannot open');
          },
        },
      ),
    ).toMatchObject({ status: 'rejected_before_write', error: { error: 'cache_unavailable' } });
    expect(deps.bridge.createPlaylist).not.toHaveBeenCalled();
  });

  it('holds operation ownership across the external call without holding a transaction', async () => {
    vi.mocked(deps.bridge.createPlaylist).mockImplementation(async () => {
      expect(deps.cacheInstance.db.inTransaction).toBe(false);
      expect(await createPlaylist({ name: 'Competing', trackIds: requested }, deps)).toMatchObject({
        status: 'rejected_before_write',
        error: { error: 'operation_busy' },
      });

      return destination;
    });
    expect(await createPlaylist({ name: 'Mix', trackIds: requested }, deps)).toMatchObject({
      status: 'observed_success',
    });
    expect(deps.bridge.createPlaylist).toHaveBeenCalledTimes(1);
    await withOperation(deps.cacheInstance, 'music', async () => {});
  });

  it.each([
    'jxa_error',
    'automation_permission_denied',
    'music_app_not_running',
    'track_not_found',
  ] as const)('does not infer pre-write proof from the %s error code', async (code) => {
    vi.mocked(deps.bridge.createPlaylist).mockRejectedValue(new BridgeError(code, 'interrupted'));
    expect(await createPlaylist({ name: 'Mix', trackIds: requested }, deps)).toMatchObject({
      status: 'write_uncertain',
      error: { error: code },
    });
    expect(deps.bridge.createPlaylist).toHaveBeenCalledTimes(1);
  });

  it('releases only explicit pre-write proof and gives partial evidence precedence', async () => {
    vi.mocked(deps.bridge.createPlaylist).mockRejectedValueOnce(
      new BridgeError('track_not_found', 'validated guard', undefined, undefined, 'not_started'),
    );
    expect(await createPlaylist({ name: 'Mix', trackIds: requested }, deps)).toMatchObject({
      status: 'rejected_before_write',
      error: { error: 'track_not_found' },
    });
    vi.mocked(deps.bridge.createPlaylist).mockRejectedValueOnce(
      new BridgeError(
        'track_not_found',
        'contradictory error',
        undefined,
        { playlist_id: 'P-PARTIAL' },
        'not_started',
      ),
    );
    expect(await createPlaylist({ name: 'Mix', trackIds: requested }, deps)).toMatchObject({
      status: 'write_uncertain',
      error: { partial_write: { playlist_id: 'P-PARTIAL' } },
    });
    expect(deps.bridge.createPlaylist).toHaveBeenCalledTimes(2);
  });

  it('retains partial readback from a failed bridge call without writing local state', async () => {
    const before = localState();

    vi.mocked(deps.bridge.createPlaylist).mockRejectedValue(
      new BridgeError('jxa_error', 'partial', undefined, {
        playlist_id: destination.persistentId,
        observed_track_ids: observed,
      }),
    );
    expect(await createPlaylist({ name: 'Mix', trackIds: requested }, deps)).toMatchObject({
      status: 'write_uncertain',
      error: { partial_write: { playlist_id: 'P-NEW', observed_track_ids: observed } },
    });
    expect(localState()).toEqual(before);
    expect(deps.bridge.createPlaylist).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['destination', "BEFORE INSERT ON playlists WHEN NEW.persistent_id = 'P-NEW'"],
    [
      'membership',
      "BEFORE INSERT ON playlist_tracks WHEN NEW.playlist_persistent_id = 'P-NEW' AND NEW.position = 1",
    ],
    ['receipt', "BEFORE INSERT ON playlist_creations WHEN NEW.created_persistent_id = 'P-NEW'"],
    ['note', "BEFORE INSERT ON notes WHEN NEW.subject_id = 'P-NEW'"],
  ])(
    'rolls back %s failure while retaining external identity and exact order',
    async (_step, trigger) => {
      const before = localState();

      failStatement(trigger);
      expect(
        await createPlaylist({ name: 'Mix', trackIds: requested, note: 'approved' }, deps),
      ).toMatchObject({
        status: 'persistence_failed',
        observed: { playlist: destination },
        error: {
          error: 'cache_unavailable',
          partial_write: { playlist_id: 'P-NEW', observed_track_ids: observed },
        },
      });
      expect(localState()).toEqual(before);
      expect(deps.bridge.createPlaylist).toHaveBeenCalledTimes(1);
      expect(deps.bridge.readLibrary).not.toHaveBeenCalled();
    },
  );

  it('returns observed identity on the direct tool persistence error', async () => {
    failStatement("BEFORE INSERT ON playlist_creations WHEN NEW.created_persistent_id = 'P-NEW'");
    expect(await handleCreatePlaylist({ name: 'Mix', track_ids: requested }, deps)).toMatchObject({
      error: 'cache_unavailable',
      partial_write: { playlist_id: 'P-NEW', observed_track_ids: observed },
    });
    expect(deps.bridge.createPlaylist).toHaveBeenCalledTimes(1);
  });

  it('commits observed order and receipt with the note', async () => {
    expect(
      await handleCreatePlaylist({ name: 'Mix', track_ids: requested, note: 'approved' }, deps),
    ).toMatchObject({
      playlist_id: 'P-NEW',
      track_count: 3,
      order_matches_request: false,
      note: { body: 'approved' },
    });
    expect(deps.cacheInstance.getPlaylistTrackIds('P-NEW')).toEqual(observed);
    expect(
      deps.cacheInstance.db.prepare('SELECT track_ids_json FROM playlist_creations').get(),
    ).toEqual({ track_ids_json: JSON.stringify(observed) });
    expect(deps.cacheInstance.getNote('playlist', 'P-NEW')?.body).toBe('approved');
  });
});

describe('clone persistence and preview rekey', () => {
  beforeEach(() => {
    const cache = deps.cacheInstance;

    cache.upsertPlaylistAfterWrite(
      { persistentId: 'P-OLD', trackCount: requested.length },
      PREVIEW_PLAYLIST_NAME,
      requested,
    );
    cache.recordPlaylistCreation('P-OLD', PREVIEW_PLAYLIST_NAME, requested);
    cache.setNote('playlist', 'P-OLD', 'preview note');
    vi.mocked(deps.bridge.clonePlaylist).mockResolvedValue({
      ...destination,
      sourcePersistentId: 'P-LIVE',
      sourceName: PREVIEW_PLAYLIST_NAME,
      sourceTrackPersistentIds: requested,
    });
  });

  it.each([
    [
      'source receipt',
      "BEFORE UPDATE ON playlist_creations WHEN OLD.created_persistent_id = 'P-OLD'",
    ],
    ['source note', "BEFORE UPDATE ON notes WHEN NEW.subject_id = 'P-LIVE'"],
    [
      'source membership',
      "BEFORE INSERT ON playlist_tracks WHEN NEW.playlist_persistent_id = 'P-LIVE'",
    ],
    ['source removal', "BEFORE DELETE ON playlists WHEN OLD.persistent_id = 'P-OLD'"],
    ['destination note', "BEFORE INSERT ON notes WHEN NEW.subject_id = 'P-NEW'"],
  ])('rolls back all creation and rekey state on %s failure', async (_step, trigger) => {
    const before = localState();

    failStatement(trigger);
    expect(
      await createPlaylist({ name: 'Mix', sourcePlaylistId: 'P-OLD', note: 'new note' }, deps),
    ).toMatchObject({
      status: 'persistence_failed',
      observed: { playlist: destination, source: { playlistId: 'P-LIVE', trackIds: requested } },
      error: { partial_write: { playlist_id: 'P-NEW', observed_track_ids: observed } },
    });
    expect(localState()).toEqual(before);
    expect(deps.bridge.clonePlaylist).toHaveBeenCalledTimes(1);
    expect(deps.bridge.createPlaylist).not.toHaveBeenCalled();
  });

  it('commits source alias/note and destination receipt/note with their distinct orders', async () => {
    const result = await handleCreatePlaylist(
      { name: 'Mix', source_playlist_id: 'P-OLD', note: 'new note' },
      deps,
    );

    expect(result).toMatchObject({
      playlist_id: 'P-NEW',
      order_matches_request: false,
      source: { playlist_id: 'P-LIVE', rekeyed_from: 'P-OLD' },
    });
    expect(deps.cacheInstance.resolvePlaylistId('P-OLD')).toBe('P-LIVE');
    expect(deps.cacheInstance.getPlaylistTrackIds('P-LIVE')).toEqual(requested);
    expect(deps.cacheInstance.getPlaylistTrackIds('P-NEW')).toEqual(observed);
    expect(deps.cacheInstance.getNote('playlist', 'P-LIVE')?.body).toBe('preview note');
    expect(deps.cacheInstance.getNote('playlist', 'P-NEW')?.body).toBe('new note');
  });
});
