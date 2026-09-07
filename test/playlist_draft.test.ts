import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DraftStore } from '../src/drafts/store.js';
import { PlaylistDraftTools } from '../src/tools/playlist_draft.js';
import { createServer } from '../dist/server.js';
import { DRAFT_RESOURCE } from '../src/draft_app.js';
import { BridgeError } from '../src/types/errors.js';
import { makeToolDeps } from './helpers.js';

let dir: string;
let store: DraftStore;
let deps: ReturnType<typeof makeToolDeps>;
let tools: PlaylistDraftTools;
const ids = ['T-TEARDROP', 'T-TEARDROP'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'selecta-draft-'));
  store = new DraftStore(join(dir, 'drafts.db'));
  deps = makeToolDeps();
  tools = new PlaylistDraftTools(deps, store);
});
afterEach(() => {
  deps.cacheInstance.close();
  rmSync(dir, { recursive: true, force: true });
});

async function draft() {
  const result = await tools.show({
    draft_id: randomUUID(),
    name: 'Whole volume knob',
    track_ids: ids,
  });

  if (!('draft' in result)) throw new Error(JSON.stringify(result));

  return result.draft;
}

describe('card appearance', () => {
  it('defaults to host without creating storage and reads older draft stores', async () => {
    expect(tools.appearance({})).toEqual({ appearance: 'host' });
    expect(existsSync(store.path)).toBe(false);
    await draft();
    expect(tools.appearance({})).toEqual({ appearance: 'host' });
  });
  it('persists separately across cards without changing draft state', async () => {
    const original = await draft();

    for (const appearance of ['copper', 'cobalt', 'ember', 'moss', 'oxblood', 'oled', 'host']) {
      expect(tools.appearance({ appearance })).toEqual({ appearance });
      expect(new DraftStore(store.path).appearance()).toBe(appearance);
      expect(store.get(original.draft_id)).toEqual(original);
    }

    expect(deps.bridge.createPlaylist).not.toHaveBeenCalled();
  });
  it('rejects invalid settings and reports storage failure without overwriting', () => {
    expect(tools.appearance({ appearance: 'invalid' })).toMatchObject({
      error: 'validation_error',
    });
    expect(existsSync(store.path)).toBe(false);
    vi.spyOn(store, 'appearance').mockImplementation(() => {
      throw new BridgeError('cache_unavailable', 'broken storage');
    });
    expect(tools.appearance({})).toMatchObject({ error: 'cache_unavailable' });
  });
});

describe('playlist drafts', () => {
  it('retains duplicate occurrences and existing inspection facts without bridge calls', async () => {
    const result = await tools.show({ draft_id: randomUUID(), name: 'Repeated', track_ids: ids });

    expect(result).toMatchObject({
      draft: { revision: 1, entries: [{ track_id: ids[0] }, { track_id: ids[1] }] },
      inspection: { duplicate_ids: [{ count: 2, positions: [0, 1] }] },
    });

    if (!('draft' in result)) throw new Error('missing draft');

    expect(new Set(result.draft.entries.map((entry) => entry.entry_id)).size).toBe(2);

    for (const fn of Object.values(deps.bridge)) expect(fn).not.toHaveBeenCalled();
  });
  it('persists order, exact selection, pins and feedback across instances; rejects stale cards', async () => {
    const original = await draft();
    const entries = [...original.entries].reverse();

    entries[0].pinned = true;
    const edited = await tools.edit({
      draft_id: original.draft_id,
      revision: 1,
      entries,
      selected_entry_ids: [entries[0].entry_id],
      feedback: 'Keep this occurrence',
    });

    expect(edited).toMatchObject({
      draft: { revision: 2, entries, selected_entry_ids: [entries[0].entry_id] },
    });
    const reopened = new PlaylistDraftTools(deps, new DraftStore(store.path));

    expect(await reopened.get({ draft_id: original.draft_id })).toEqual(edited);
    expect(
      await tools.edit({ draft_id: original.draft_id, revision: 1, entries: original.entries }),
    ).toMatchObject({ error: 'draft_revision_conflict' });
    expect(store.get(original.draft_id).entries).toEqual(entries);
  });
  it('never silently recreates an existing identity', async () => {
    const original = await draft();

    expect(
      await tools.show({ draft_id: original.draft_id, name: 'Overwrite', track_ids: ids }),
    ).toMatchObject({ error: 'draft_revision_conflict' });
    expect(store.get(original.draft_id).name).toBe(original.name);
  });
  it('read-only missing recovery does not create a store, and existing recovery does not change it', async () => {
    expect(await tools.get({ draft_id: randomUUID() })).toMatchObject({ error: 'draft_not_found' });
    expect(existsSync(store.path)).toBe(false);
    const original = await draft();
    const before = statSync(store.path).mtimeMs;

    await tools.get({ draft_id: original.draft_id });
    expect(statSync(store.path).mtimeMs).toBe(before);
  });
  it('rejects invalid IDs, unknown tracks and occurrence reassignment', async () => {
    expect(await tools.show({ draft_id: 'bad', name: 'x', track_ids: ids })).toMatchObject({
      error: 'validation_error',
    });
    expect(
      await tools.show({ draft_id: randomUUID(), name: 'x', track_ids: ['MISSING'] }),
    ).toMatchObject({ error: 'track_not_found' });
    const original = await draft();

    for (const patch of [
      { entries: [original.entries[0], original.entries[0]] },
      { selected_entry_ids: [randomUUID()] },
      { selected_entry_ids: [original.entries[0].entry_id, original.entries[0].entry_id] },
      { entries: [{ ...original.entries[0], entry_id: randomUUID() }] },
      { entries: [{ ...original.entries[0], track_id: 'MISSING' }] },
    ])
      expect(
        await tools.edit({ draft_id: original.draft_id, revision: 1, ...patch }),
      ).toHaveProperty('error');

    expect(store.get(original.draft_id).revision).toBe(1);
  });
  it('recovers a draft with missing library tracks, but refuses save', async () => {
    const original = await draft();

    deps.cacheInstance.db.prepare('DELETE FROM tracks WHERE persistent_id = ?').run(ids[0]);
    expect(await tools.get({ draft_id: original.draft_id })).toMatchObject({
      draft: original,
      inspection_error: { error: 'track_not_found' },
    });
    expect(await tools.save({ draft_id: original.draft_id, revision: 1 })).toMatchObject({
      error: 'track_not_found',
    });
    expect(deps.bridge.createPlaylist).not.toHaveBeenCalled();
  });
  it('saves only the exact revision using the existing creation contract, once', async () => {
    const original = await draft();

    vi.mocked(deps.bridge.createPlaylist).mockResolvedValue({
      persistentId: 'P-SAVED',
      trackCount: 2,
      trackPersistentIds: ids,
    });
    expect(await tools.save({ draft_id: original.draft_id, revision: 9 })).toMatchObject({
      error: 'draft_revision_conflict',
    });
    const saved = await tools.save({ draft_id: original.draft_id, revision: 1 });

    expect(saved).toMatchObject({
      saved_revision: 1,
      draft: { revision: 3, save: { status: 'finished' } },
      result: { playlist_id: 'P-SAVED' },
    });
    expect(deps.bridge.createPlaylist).toHaveBeenCalledWith({
      name: original.name,
      trackIds: ids,
      description: undefined,
    });
    expect(await tools.save({ draft_id: original.draft_id, revision: 1 })).toMatchObject({
      error: 'draft_revision_conflict',
    });
    expect(await tools.save({ draft_id: original.draft_id, revision: 3 })).toMatchObject({
      error: 'validation_error',
    });
    expect(deps.bridge.createPlaylist).toHaveBeenCalledTimes(1);
  });
  it('persists partial errors and blocks concurrent edits and writes while saving', async () => {
    const original = await draft();
    let reject!: (error: unknown) => void;

    vi.mocked(deps.bridge.createPlaylist).mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const pending = tools.save({ draft_id: original.draft_id, revision: 1 });

    await vi.waitFor(() => expect(deps.bridge.createPlaylist).toHaveBeenCalledTimes(1));
    expect(
      await tools.edit({ draft_id: original.draft_id, revision: 2, feedback: 'racing edit' }),
    ).toMatchObject({ error: 'operation_busy' });
    expect(await tools.save({ draft_id: original.draft_id, revision: 2 })).toHaveProperty('error');
    reject(
      new BridgeError('jxa_error', 'Failed', 'Inspect the partial playlist', {
        playlist_id: 'P-PARTIAL',
      }),
    );
    expect(await pending).toMatchObject({
      error: 'jxa_error',
      partial_write: { playlist_id: 'P-PARTIAL' },
      draft: { save: { result: { error: 'jxa_error' } } },
    });
    expect(store.get(original.draft_id).save?.status).toBe('finished');
  });
  it('preserves the Music.app outcome if persisting its receipt fails', async () => {
    const original = await draft();

    vi.mocked(deps.bridge.createPlaylist).mockResolvedValue({
      persistentId: 'P-SAVED',
      trackCount: 2,
      trackPersistentIds: ids,
    });
    const update = store.update.bind(store);

    vi.spyOn(store, 'update').mockImplementation((id, revision, change) => {
      if (revision === 2) throw new BridgeError('cache_unavailable', 'disk full');

      return update(id, revision, change);
    });
    expect(await tools.save({ draft_id: original.draft_id, revision: 1 })).toMatchObject({
      error: 'cache_unavailable',
      result: { playlist_id: 'P-SAVED' },
      partial_write: { playlist_id: 'P-SAVED' },
      draft: { save: { status: 'pending' } },
    });
    expect(store.get(original.draft_id).save?.status).toBe('pending');
    expect(deps.bridge.createPlaylist).toHaveBeenCalledTimes(1);
  });
  it('selection, feedback and pins preserve the completed save guard', async () => {
    const original = await draft();

    vi.mocked(deps.bridge.createPlaylist).mockResolvedValue({
      persistentId: 'P-SAVED',
      trackCount: 2,
      trackPersistentIds: ids,
    });
    await tools.save({ draft_id: original.draft_id, revision: 1 });
    await tools.edit({
      draft_id: original.draft_id,
      revision: 3,
      entries: original.entries.map((entry) => ({ ...entry, pinned: true })),
      feedback: 'Keep both',
      selected_entry_ids: [original.entries[0].entry_id],
    });
    expect(store.get(original.draft_id).save?.status).toBe('finished');
    expect(await tools.save({ draft_id: original.draft_id, revision: 4 })).toHaveProperty('error');
    expect(deps.bridge.createPlaylist).toHaveBeenCalledTimes(1);
  });
  it('leaves interrupted pending outcomes blocked after reopening', async () => {
    const original = await draft();

    store.update(original.draft_id, 1, (value) => ({
      ...value,
      save: { revision: 1, status: 'pending' },
    }));
    const reopened = new PlaylistDraftTools(deps, new DraftStore(store.path));

    expect(await reopened.save({ draft_id: original.draft_id, revision: 2 })).toHaveProperty(
      'error',
    );
    expect(deps.bridge.createPlaylist).not.toHaveBeenCalled();
  });
  it('registers the bundled widget, structured fallback and read-only recovery over MCP', async () => {
    const server = createServer(deps, store);
    const client = new Client({ name: 'draft-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(a), client.connect(b)]);

    try {
      const listed = await client.listTools();

      expect(listed.tools.find((item) => item.name === 'show_playlist_draft')?._meta).toMatchObject(
        { ui: { resourceUri: DRAFT_RESOURCE } },
      );
      expect(
        listed.tools.find((item) => item.name === 'playlist_draft_appearance')?._meta,
      ).toMatchObject({ ui: { visibility: ['app'] } });
      expect(
        (
          await client.callTool({
            name: 'playlist_draft_appearance',
            arguments: { appearance: 'oled' },
          })
        ).structuredContent,
      ).toEqual({ appearance: 'oled' });
      const resource = await client.readResource({ uri: DRAFT_RESOURCE });

      expect(resource.contents[0].mimeType).toBe('text/html;profile=mcp-app');
      expect(resource.contents[0].text).toContain('Save this revision to Music.app');
      expect(resource.contents[0].text).not.toContain('/*__APP__*/');
      expect(resource.contents[0].text).not.toContain('/*__PULSE__*/');
      const id = randomUUID();
      const result = await client.callTool({
        name: 'show_playlist_draft',
        arguments: { draft_id: id, name: 'Wire test', track_ids: ids },
      });

      expect(result.structuredContent).toMatchObject({ draft: { draft_id: id, revision: 1 } });
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(
        result.structuredContent,
      );
      expect(
        (
          await client.callTool({
            name: 'get_playlist_draft',
            arguments: { draft_id: randomUUID() },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
