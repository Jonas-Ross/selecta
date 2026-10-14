import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { DraftStore } from '../src/drafts/store.js';
import { PlaylistDraftTools } from '../src/tools/playlist_draft.js';
import { BridgeError, preWriteError } from '../src/types/errors.js';
import { makeToolDeps } from './helpers.js';

let dir: string;
let store: DraftStore;
let deps: ReturnType<typeof makeToolDeps>;
let tools: PlaylistDraftTools;
let draftId: string;
const ids = ['T-ROADS', 'T-TEARDROP'];
const reordered = ['T-TEARDROP', 'T-ROADS'];
const written = (trackPersistentIds: string[], persistentId = 'P-SAVED') => ({
  persistentId,
  trackCount: trackPersistentIds.length,
  trackPersistentIds,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'selecta-draft-update-'));
  store = new DraftStore(join(dir, 'drafts.db'));
  deps = makeToolDeps({
    createPlaylist: vi.fn(async ({ trackIds }) => written(trackIds)),
    overwritePlaylist: vi.fn(async ({ trackIds }) => written(trackIds)),
  });
  tools = new PlaylistDraftTools({ ...deps, drafts: () => store });
  draftId = randomUUID();
  await tools.show({ draft_id: draftId, name: 'Mix', track_ids: ids });
  await tools.save({ draft_id: draftId, revision: 1 });
});
afterEach(() => {
  deps.cacheInstance.close();
  rmSync(dir, { recursive: true, force: true });
});

async function reorder() {
  const draft = store.get(draftId);

  await tools.edit({
    draft_id: draftId,
    revision: draft.revision,
    name: 'Mix II',
    entries: [draft.entries[1], draft.entries[0]],
  });

  return store.get(draftId).revision;
}

it('keeps the saved playlist through edits and rewrites it in place on the next save', async () => {
  expect(store.get(draftId).playlist).toEqual({
    playlist_id: 'P-SAVED',
    name: 'Mix',
    track_ids: ids,
  });

  const revision = await reorder();

  expect(store.get(draftId).save).toBeUndefined();
  expect(store.get(draftId).playlist).toMatchObject({ playlist_id: 'P-SAVED' });
  expect(await tools.save({ draft_id: draftId, revision })).toMatchObject({
    result: { playlist_id: 'P-SAVED', name: 'Mix II', track_count: 2, updated: true },
  });
  expect(deps.bridge.overwritePlaylist).toHaveBeenCalledWith({
    playlistId: 'P-SAVED',
    savedName: 'Mix',
    knownIds: expect.not.arrayContaining(['P-SAVED']),
    followRekey: true,
    name: 'Mix II',
    trackIds: reordered,
    expectedTrackIds: ids,
  });
  expect(deps.bridge.createPlaylist).toHaveBeenCalledTimes(1);
  expect(store.get(draftId).playlist).toEqual({
    playlist_id: 'P-SAVED',
    name: 'Mix II',
    track_ids: reordered,
  });
  expect(deps.cacheInstance.getPlaylistTrackIds('P-SAVED')).toEqual(reordered);
  expect(deps.cacheInstance.getRecentCreationNames(60)).toEqual(['Mix II']);
});

it('rekeys the cache when the update followed a rotated ID', async () => {
  vi.mocked(deps.bridge.overwritePlaylist).mockImplementationOnce(async ({ trackIds }) =>
    written(trackIds, 'P-ROTATED'),
  );

  const revision = await reorder();

  await tools.save({ draft_id: draftId, revision });
  expect(store.get(draftId).playlist).toMatchObject({ playlist_id: 'P-SAVED' });
  expect(deps.cacheInstance.getPlaylist('P-SAVED')).toBeNull();
  expect(deps.cacheInstance.resolvePlaylistId('P-SAVED')).toBe('P-ROTATED');
  expect(deps.cacheInstance.getPlaylistTrackIds('P-ROTATED')).toEqual(reordered);

  await tools.save({ draft_id: draftId, revision: await reorder() });
  expect(deps.bridge.overwritePlaylist).toHaveBeenLastCalledWith(
    expect.objectContaining({
      playlistId: 'P-ROTATED',
      knownIds: expect.not.arrayContaining(['P-ROTATED']),
    }),
  );
});

it('names every playlist the cache knows, so a rotated-ID lookup never takes one', async () => {
  deps.cacheInstance.upsertPlaylistAfterWrite(written(ids, 'P-COPY'), 'Since renamed', ids);

  const revision = await reorder();

  await tools.save({ draft_id: draftId, revision });
  expect(deps.bridge.overwritePlaylist).toHaveBeenCalledWith(
    expect.objectContaining({ knownIds: expect.arrayContaining(['P-COPY']) }),
  );
});

it("follows a rotated ID by name only within refresh's rekey window", async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 61 * 60_000);

  try {
    await tools.save({ draft_id: draftId, revision: await reorder() });
  } finally {
    vi.useRealTimers();
  }

  expect(deps.bridge.overwritePlaylist).toHaveBeenCalledWith(
    expect.objectContaining({ followRekey: false }),
  );
});

it('lets go of a playlist changed in Music, so the next save makes a new one', async () => {
  vi.mocked(deps.bridge.overwritePlaylist).mockRejectedValueOnce(
    preWriteError('validation_error', 'drifted', 'Changed in Music.app.'),
  );

  const revision = await reorder();
  const refused = await tools.save({ draft_id: draftId, revision });

  expect(refused).toMatchObject({
    error: 'validation_error',
    hint: 'Changed in Music.app. Save again to make it a new playlist.',
  });
  expect(store.get(draftId).save).toBeUndefined();
  expect(store.get(draftId).playlist).toBeUndefined();

  await tools.save({ draft_id: draftId, revision: store.get(draftId).revision });
  expect(deps.bridge.createPlaylist).toHaveBeenCalledTimes(2);
});

it('keeps the link through a refusal that says nothing about the playlist', async () => {
  vi.mocked(deps.bridge.overwritePlaylist).mockRejectedValueOnce(
    preWriteError('track_not_found', 'gone', 'Refresh.'),
  );

  const revision = await reorder();

  expect(await tools.save({ draft_id: draftId, revision })).toMatchObject({
    error: 'track_not_found',
  });
  expect(store.get(draftId).save).toBeUndefined();
  expect(store.get(draftId).playlist).toMatchObject({ playlist_id: 'P-SAVED' });
});

it('holds an update of unknown outcome like any uncertain save', async () => {
  vi.mocked(deps.bridge.overwritePlaylist).mockRejectedValueOnce(
    new BridgeError('jxa_error', 'osascript died'),
  );

  const revision = await reorder();

  expect(await tools.save({ draft_id: draftId, revision })).toMatchObject({
    error: 'jxa_error',
    result: { updated: true },
  });
  expect(store.get(draftId).save).toMatchObject({
    status: 'finished',
    result: { error: 'jxa_error' },
  });
  expect(
    await tools.save({ draft_id: draftId, revision: store.get(draftId).revision }),
  ).toHaveProperty('error', 'validation_error');
  expect(deps.bridge.overwritePlaylist).toHaveBeenCalledTimes(1);
});

it('reads the playlist of a save made before drafts kept one', async () => {
  const legacy = randomUUID();
  const body = (result: Record<string, unknown>) =>
    JSON.stringify({
      ...store.get(draftId),
      draft_id: legacy,
      playlist: undefined,
      save: { revision: 1, status: 'finished', result },
    });
  const write = (result: Record<string, unknown>) =>
    new Database(store.path)
      .prepare('INSERT OR REPLACE INTO drafts VALUES (?, ?)')
      .run(legacy, body(result));

  write({ playlist_id: 'P-OLD', name: 'Old', track_count: 2 });
  expect(store.get(legacy).playlist).toEqual({ playlist_id: 'P-OLD', name: 'Old', track_ids: ids });

  write({ playlist_id: 'P-OLD', name: 'Old', track_count: 2, order_matches_request: false });
  expect(store.get(legacy).playlist).toBeUndefined();

  write({ error: 'jxa_error', partial_write: { playlist_id: 'P-OLD' } });
  expect(store.get(legacy).playlist).toBeUndefined();
});
