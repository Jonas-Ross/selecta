import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { PlaylistDraftTools } from '../src/tools/playlist_draft.js';
import { handlePreviewPlaylist } from '../src/tools/preview_playlist.js';
import { BridgeError } from '../src/types/errors.js';
import { DraftStore } from '../src/drafts/store.js';
import { makeToolDeps } from './helpers.js';
import type { Draft, DraftView } from '../src/drafts/contracts.js';

const A = 'T-TEARDROP';
const B = 'T-ROADS';
let deps: ReturnType<typeof makeToolDeps>;
let tools: PlaylistDraftTools;
let store: DraftStore;
const view = (value: unknown) =>
  value as DraftView & { local_edit_saved?: boolean; preview_result?: Record<string, unknown> };
const exact = (draft: Draft) => ({ draft_id: draft.draft_id, revision: draft.revision });
const order = (draft: Draft) => draft.entries.map((entry) => entry.track_id);

async function create() {
  return view(await tools.show({ draft_id: randomUUID(), name: 'Fixture', track_ids: [A, B, A] }))
    .draft;
}

async function start() {
  const draft = await create();

  return view(await tools.preview(exact(draft))).draft;
}

async function reverse(draft: Draft) {
  return view(
    await tools.edit({
      ...exact(draft),
      entries: [draft.entries[1], draft.entries[0], draft.entries[2]],
    }),
  );
}

beforeEach(() => {
  deps = makeToolDeps({
    replacePlaylist: vi.fn(async ({ trackIds }) => ({
      persistentId: 'P-SLOT',
      trackCount: trackIds.length,
      trackPersistentIds: trackIds,
      created: false,
    })),
  });
  store = deps.drafts!();
  tools = new PlaylistDraftTools({ ...deps, drafts: () => store });
});
afterEach(() => deps.cacheInstance.close());

it('links explicit preview and synchronizes repeated occurrences at the accepted revision', async () => {
  const draft = await start();
  const changed = await reverse(draft);

  expect(changed).toMatchObject({
    local_edit_saved: true,
    preview: { status: 'current', content_revision: 2, baseline: [B, A, A] },
  });
  expect(changed.draft.entries.map((e) => e.entry_id)).toEqual([
    draft.entries[1].entry_id,
    draft.entries[0].entry_id,
    draft.entries[2].entry_id,
  ]);
  expect(deps.bridge.replacePlaylist).toHaveBeenLastCalledWith({
    name: 'Selecta Preview',
    trackIds: [B, A, A],
    expectedTrackIds: [A, B, A],
  });
  expect(new DraftStore(store.path).preview()?.status).toBe('current');
  expect(deps.bridge.createPlaylist).not.toHaveBeenCalled();
});

it('keeps name, selection, feedback and identical ordered-track changes local', async () => {
  let draft = await start();

  for (const patch of [
    { name: 'Renamed' },
    { selected_entry_ids: [draft.entries[2].entry_id] },
    { feedback: 'louder' },
    { entries: draft.entries },
  ]) {
    draft = view(await tools.edit({ ...exact(draft), ...patch })).draft;
  }

  expect(deps.bridge.replacePlaylist).toHaveBeenCalledTimes(1);
  expect(store.preview()?.status).toBe('current');
});

it('rejects stale edit and start revisions without replaying a write', async () => {
  const draft = await start();

  await reverse(draft);
  expect(await tools.preview(exact(draft))).toMatchObject({ error: 'draft_revision_conflict' });
  expect(await tools.edit({ ...exact(draft), entries: draft.entries })).toMatchObject({
    error: 'draft_revision_conflict',
  });
  expect(deps.bridge.replacePlaylist).toHaveBeenCalledTimes(2);
});

it('a newer draft or raw preview revokes ownership across store instances', async () => {
  let old = await start();
  const firstGeneration = store.preview()!.generation;

  await start();
  expect(store.preview()!.generation).not.toBe(firstGeneration);
  old = (await reverse(old)).draft;
  expect(deps.bridge.replacePlaylist).toHaveBeenCalledTimes(2);
  const active = await start();

  await handlePreviewPlaylist(
    { track_ids: [B] },
    { ...deps, drafts: () => new DraftStore(store.path) },
  );
  await reverse(active);
  expect(deps.bridge.replacePlaylist).toHaveBeenCalledTimes(4);
  expect(view(await tools.get({ draft_id: old.draft_id })).preview?.status).toBe('inactive');
});

it('invalidates linkage before a failed raw replacement', async () => {
  const draft = await start();

  vi.mocked(deps.bridge.replacePlaylist).mockRejectedValueOnce(
    new BridgeError('jxa_error', 'unknown'),
  );
  await handlePreviewPlaylist({ track_ids: [B] }, { ...deps, drafts: () => store });
  await reverse(draft);
  expect(deps.bridge.replacePlaylist).toHaveBeenCalledTimes(2);
  expect(store.preview()?.status).toBe('inactive');
});

it('preserves local edits on manual drift and requires an explicitly reconciled baseline', async () => {
  const draft = await start();

  vi.mocked(deps.bridge.replacePlaylist).mockRejectedValueOnce(
    new BridgeError('preview_conflict', 'manual change'),
  );
  const changed = await reverse(draft);

  expect(changed).toMatchObject({ local_edit_saved: true, preview: { status: 'conflict' } });
  expect(order(store.get(draft.draft_id))).toEqual([B, A, A]);
  const next = await reverse(changed.draft);

  await tools.preview(exact(next.draft));
  expect(deps.bridge.replacePlaylist).toHaveBeenCalledTimes(2);
  expect(
    view(await tools.preview({ ...exact(next.draft), expected_track_ids: [B] })).preview?.status,
  ).toBe('current');
  expect(deps.bridge.replacePlaylist).toHaveBeenLastCalledWith({
    name: 'Selecta Preview',
    trackIds: [A, B, A],
    expectedTrackIds: [B],
  });
});

it.each(['jxa_error', 'automation_permission_denied', 'music_app_not_running'] as const)(
  'retains the draft and blocks automatic retries after %s',
  async (code) => {
    const draft = await start();

    vi.mocked(deps.bridge.replacePlaylist).mockRejectedValueOnce(
      new BridgeError(code, 'failed', undefined, {
        playlist_id: 'PARTIAL',
        observed_track_ids: [],
      }),
    );
    const changed = await reverse(draft);

    expect(changed).toMatchObject({
      local_edit_saved: true,
      preview: {
        status: 'uncertain',
        result: { error: code, partial_write: { playlist_id: 'PARTIAL', observed_track_ids: [] } },
      },
    });
    await reverse(changed.draft);
    expect(deps.bridge.replacePlaylist).toHaveBeenCalledTimes(2);
  },
);

it('reports incomplete observed population instead of claiming current', async () => {
  const draft = await start();

  vi.mocked(deps.bridge.replacePlaylist).mockResolvedValueOnce({
    persistentId: 'P-SLOT',
    trackCount: 0,
    trackPersistentIds: [],
    created: false,
  });
  const result = await reverse(draft);

  expect(result.preview).toMatchObject({
    status: 'conflict',
    baseline: [],
    result: { observed_track_ids: [], order_matches_request: false },
  });
});

it('preserves readback through cache and draft receipt persistence failures', async () => {
  const draft = await start();

  deps.cacheInstance.db.exec(
    "CREATE TEMP TRIGGER fail_preview BEFORE INSERT ON playlists BEGIN SELECT RAISE(ABORT, 'cache failed'); END",
  );
  const db = new Database(store.path);

  // The pending claim persists, while final receipt persistence fails.
  db.exec(
    "CREATE TRIGGER fail_receipt BEFORE UPDATE ON preview_slot WHEN json_extract(new.body, '$.status') != 'pending' AND json_extract(old.body, '$.status') = 'pending' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END",
  );
  db.close();
  const result = await reverse(draft);

  expect(result).toMatchObject({
    local_edit_saved: true,
    preview: {
      status: 'error',
      result: {
        playlist_id: 'P-SLOT',
        observed_track_ids: [B, A, A],
        partial_write: { observed_track_ids: [B, A, A] },
      },
    },
  });
  expect(store.preview()?.status).toBe('pending');
  expect(order(store.get(draft.draft_id))).toEqual([B, A, A]);
  expect(await reverse(result.draft)).toMatchObject({ error: 'operation_busy' });
  expect(deps.bridge.replacePlaylist).toHaveBeenCalledTimes(2);
});

it('rejects concurrent ordered edits before mutation while permitting metadata edits', async () => {
  const draft = await start();

  vi.mocked(deps.bridge.replacePlaylist).mockImplementationOnce(async ({ trackIds }) => {
    expect(deps.cacheInstance.db.inTransaction).toBe(false);
    const pending = store.preview();

    expect(pending?.status).toBe('pending');
    const other = new PlaylistDraftTools({ ...deps, drafts: () => new DraftStore(store.path) });
    const latest = store.get(draft.draft_id);
    const changed = view(await other.edit({ ...exact(latest), entries: [latest.entries[0]] }));

    expect(changed).toMatchObject({ error: 'operation_busy' });
    expect(order(store.get(draft.draft_id))).toEqual([B, A, A]);
    const metadata = view(await other.edit({ ...exact(latest), feedback: 'keep this' }));

    expect(metadata.draft.feedback).toBe('keep this');

    return {
      persistentId: 'P-SLOT',
      trackCount: trackIds.length,
      trackPersistentIds: trackIds,
      created: false,
    };
  });
  const result = await reverse(draft);

  expect(result.preview?.status).toBe('current');
  expect(order(result.draft)).toEqual([B, A, A]);
  expect(deps.bridge.replacePlaylist).toHaveBeenCalledTimes(2);
});

it('a completion token cannot overwrite a newer slot claim', async () => {
  const draft = await create();
  const claim = store.claimPreview(draft.draft_id, draft.revision, true)!;

  store.unlinkPreview();
  expect(() => store.finishPreview(claim, { status: 'current', baseline: [A, B, A] })).toThrow(
    'ownership changed',
  );
  expect(store.preview()?.status).toBe('inactive');
});

it('keeps a known target when receipt persistence and every subsequent get fail', async () => {
  const draft = await start();

  vi.mocked(deps.bridge.replacePlaylist).mockImplementationOnce(async ({ trackIds }) => {
    vi.spyOn(store, 'finishPreview').mockImplementation(() => {
      throw new BridgeError('cache_unavailable', 'disk failed');
    });
    vi.spyOn(store, 'get').mockImplementation(() => {
      throw new BridgeError('cache_unavailable', 'still failed');
    });

    return {
      persistentId: 'OBSERVED-TARGET',
      trackCount: trackIds.length,
      trackPersistentIds: trackIds,
      created: false,
    };
  });
  const result = await reverse(draft);

  expect(result).toMatchObject({
    local_edit_saved: true,
    draft: { revision: 2 },
    preview_result: { playlist_id: 'OBSERVED-TARGET', observed_track_ids: [B, A, A] },
  });
});
it('does not permanently save a draft whose audition has unresolved manual drift', async () => {
  const draft = await start();

  vi.mocked(deps.bridge.replacePlaylist).mockRejectedValueOnce(
    new BridgeError('preview_conflict', 'manual change'),
  );
  const changed = await reverse(draft);

  expect(await tools.save(exact(changed.draft))).toMatchObject({ error: 'preview_conflict' });
  expect(deps.bridge.createPlaylist).not.toHaveBeenCalled();
});

it('adopts manual order after an interrupted pending write without rewriting Music.app', async () => {
  const draft = await create();

  store.claimPreview(draft.draft_id, draft.revision, true);
  vi.mocked(deps.bridge.readPreview).mockResolvedValue({
    persistentId: 'P-LIVE',
    trackCount: 2,
    trackPersistentIds: [B, A],
  });
  const adopted = view(
    await tools.preview({ ...exact(draft), mode: 'adopt_live', expected_track_ids: [B, A] }),
  );

  expect(order(adopted.draft)).toEqual([B, A]);
  expect(adopted.draft.entries.map((entry) => entry.entry_id)).toEqual([
    draft.entries[1].entry_id,
    draft.entries[0].entry_id,
  ]);
  expect(adopted.preview).toMatchObject({
    status: 'current',
    baseline: [B, A],
    playlist_id: 'P-LIVE',
  });
  expect(deps.bridge.replacePlaylist).not.toHaveBeenCalled();
  expect(deps.bridge.readPreview).toHaveBeenCalledWith({
    name: 'Selecta Preview',
    expectedTrackIds: [B, A],
  });
});
it('rejects stale live adoption without changing local state or writing Music.app', async () => {
  const draft = await start();

  vi.mocked(deps.bridge.readPreview).mockRejectedValue(
    new BridgeError('preview_conflict', 'live changed again'),
  );
  const result = view(
    await tools.preview({ ...exact(draft), mode: 'adopt_live', expected_track_ids: [B] }),
  );

  expect(result.preview_result).toMatchObject({ error: 'preview_conflict' });
  expect(store.get(draft.draft_id)).toEqual(draft);
  expect(store.preview()?.status).toBe('conflict');
  expect(await tools.save(exact(draft))).toMatchObject({ error: 'preview_conflict' });
  expect(deps.bridge.createPlaylist).not.toHaveBeenCalled();
  expect(deps.bridge.replacePlaylist).toHaveBeenCalledTimes(1);
});
it('explicitly detaches an interrupted/missing slot before a new start', async () => {
  const draft = await create();

  store.claimPreview(draft.draft_id, draft.revision, true);
  const detached = view(await tools.preview({ ...exact(draft), mode: 'detach' }));

  expect(detached.preview?.status).toBe('inactive');
  expect(deps.bridge.replacePlaylist).not.toHaveBeenCalled();
  const changed = await reverse(detached.draft);

  expect(changed.local_edit_saved).toBe(true);
  expect(view(await tools.preview(exact(changed.draft))).preview?.status).toBe('current');
  expect(deps.bridge.replacePlaylist).toHaveBeenCalledTimes(1);
});
