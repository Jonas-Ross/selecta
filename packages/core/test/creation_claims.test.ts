import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DraftStore } from '../src/drafts/store.js';
import { PlaylistDraftTools } from '../src/tools/playlist_draft.js';
import { withOperation } from '../src/operations/lock.js';
import { BridgeError } from '../src/types/errors.js';
import { makeToolDeps } from './helpers.js';

let dir: string;
let store: DraftStore;
let deps: ReturnType<typeof makeToolDeps>;
let tools: PlaylistDraftTools;
let draftId: string;
const ids = ['T-ROADS', 'T-TEARDROP', 'T-ROADS'];
const observed = ['T-TEARDROP', 'T-ROADS'];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'selecta-creation-claims-'));
  store = new DraftStore(join(dir, 'drafts.db'));
  deps = makeToolDeps({
    createPlaylist: vi.fn().mockResolvedValue({
      persistentId: 'P-SAVED',
      trackCount: observed.length,
      trackPersistentIds: observed,
    }),
  });
  tools = new PlaylistDraftTools({ ...deps, drafts: () => store });
  draftId = randomUUID();
  await tools.show({ draft_id: draftId, name: 'Mix', track_ids: ids });
});
afterEach(() => {
  deps.cacheInstance.close();
  rmSync(dir, { recursive: true, force: true });
});

function failDraftReceipt() {
  const update = store.update.bind(store);

  vi.spyOn(store, 'update').mockImplementation((id, revision, change) => {
    if (revision === 2) throw new BridgeError('cache_unavailable', 'draft disk full');

    return update(id, revision, change);
  });
}

async function assertNoReplay() {
  const reopened = new PlaylistDraftTools({ ...deps, drafts: () => new DraftStore(store.path) });

  expect(
    await reopened.save({ draft_id: draftId, revision: store.get(draftId).revision }),
  ).toHaveProperty('error');
  expect(deps.bridge.createPlaylist).toHaveBeenCalledTimes(1);
}

it('never attempts creation when the durable claim cannot be persisted', async () => {
  vi.spyOn(store, 'update').mockImplementation(() => {
    throw new BridgeError('cache_unavailable', 'claim disk full');
  });
  expect(await tools.save({ draft_id: draftId, revision: 1 })).toMatchObject({
    error: 'cache_unavailable',
  });
  expect(new DraftStore(store.path).get(draftId).save).toBeUndefined();
  expect(deps.bridge.createPlaylist).not.toHaveBeenCalled();
});

it('retains observed order and identity when both library persistence and draft receipt fail', async () => {
  deps.cacheInstance.db.exec(
    "CREATE TEMP TRIGGER receipt_failure BEFORE INSERT ON playlist_creations BEGIN SELECT RAISE(ABORT, 'receipt disk full'); END",
  );
  failDraftReceipt();
  expect(await tools.save({ draft_id: draftId, revision: 1 })).toMatchObject({
    error: 'cache_unavailable',
    draft: { save: { status: 'pending' } },
    result: {
      error: 'cache_unavailable',
      partial_write: { playlist_id: 'P-SAVED', observed_track_ids: observed },
    },
    partial_write: { playlist_id: 'P-SAVED', observed_track_ids: observed },
  });
  expect(deps.cacheInstance.getPlaylist('P-SAVED')).toBeNull();
  expect(store.get(draftId).save?.status).toBe('pending');
  await assertNoReplay();
});

it('returns exact observed order if recording a successful draft save fails', async () => {
  failDraftReceipt();
  expect(await tools.save({ draft_id: draftId, revision: 1 })).toMatchObject({
    draft: { save: { status: 'pending' } },
    result: { playlist_id: 'P-SAVED', order_matches_request: false },
    partial_write: { playlist_id: 'P-SAVED', observed_track_ids: observed },
  });
  expect(deps.cacheInstance.getPlaylistTrackIds('P-SAVED')).toEqual(observed);
  await assertNoReplay();
});

it('keeps an untagged permission error durable instead of granting a second write attempt', async () => {
  vi.mocked(deps.bridge.createPlaylist).mockRejectedValue(
    new BridgeError('automation_permission_denied', 'denied after an event'),
  );
  expect(await tools.save({ draft_id: draftId, revision: 1 })).toMatchObject({
    error: 'automation_permission_denied',
    draft: { save: { status: 'finished' } },
  });
  await assertNoReplay();
});

it('retains the pending claim when recording an uncertain error fails', async () => {
  vi.mocked(deps.bridge.createPlaylist).mockRejectedValue(
    new BridgeError('jxa_error', 'lost result'),
  );
  failDraftReceipt();
  expect(await tools.save({ draft_id: draftId, revision: 1 })).toMatchObject({
    error: 'cache_unavailable',
    result: { error: 'jxa_error' },
  });
  expect(store.get(draftId).save?.status).toBe('pending');
  await assertNoReplay();
});

it('keeps the pending claim if persisting a proven pre-write release fails', async () => {
  failDraftReceipt();
  await withOperation(deps.cacheInstance, 'music', async () => {
    expect(await tools.save({ draft_id: draftId, revision: 1 })).toMatchObject({
      error: 'cache_unavailable',
      result: { error: 'operation_busy' },
      draft: { save: { status: 'pending' } },
      hint: expect.stringContaining('before any write'),
    });
  });
  expect(new DraftStore(store.path).get(draftId).save?.status).toBe('pending');
  expect(deps.bridge.createPlaylist).not.toHaveBeenCalled();
});
