import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { DraftStore } from '@selecta/core/drafts/store.js';
import { makeToolDeps } from '../../../packages/core/test/helpers.js';
import { createApi } from '../src/host/api.js';
import type { AgentSessions } from '../src/host/agent.js';

const base = makeToolDeps();
const local = new DraftStore(base.drafts!().path, { localOnly: true });
const deps = { ...base, drafts: () => local };
const agent = {
  start: vi.fn(),
  send: vi.fn(),
  refuse: vi.fn(),
  cancel: vi.fn(),
  history: vi.fn(() => ({})),
};
const call = createApi(deps, agent as unknown as AgentSessions);

afterEach(() => vi.clearAllMocks());

it('lists, reads and edits drafts through the same handlers as the MCP tools', async () => {
  const draftId = randomUUID();

  deps.drafts().create(draftId, 'Warmup', ['T-TEARDROP', 'T-ROADS']);

  expect(await call('drafts.list', undefined)).toMatchObject([
    { draft_id: draftId, track_count: 2 },
  ]);

  const view = (await call('drafts.get', { draft_id: draftId })) as {
    draft: { entries: { entry_id: string; track_id: string }[] };
    inspection: { tracks: { title: string }[] };
  };

  expect(view.inspection.tracks.map((track) => track.title)).toEqual(['Teardrop', 'Roads']);

  const edited = await call('drafts.edit', {
    draft_id: draftId,
    revision: 1,
    entries: [...view.draft.entries].reverse(),
  });

  expect(edited).toMatchObject({ draft: { revision: 2 } });
  expect(
    await call('drafts.edit', { draft_id: draftId, revision: 1, name: 'Stale' }),
  ).toMatchObject({
    error: 'draft_revision_conflict',
  });
});

it('hands briefs and feedback to the agent only when they validate', async () => {
  const draftId = randomUUID();

  await call('agent.start', { draft_id: draftId, brief: '  deep house  ' });
  await call('agent.send', { draft_id: draftId, message: 'slower', text: 'typed' });
  await call('agent.send', { draft_id: draftId, message: 'x'.repeat(50_000) });
  await call('agent.cancel', { draft_id: draftId });
  expect(await call('agent.history', undefined)).toEqual({});

  expect(agent.start).toHaveBeenCalledWith(draftId, 'deep house');
  expect(agent.send).toHaveBeenCalledWith(draftId, 'slower', 'typed');
  expect(agent.send).toHaveBeenCalledTimes(2);
  expect(agent.cancel).toHaveBeenCalledWith(draftId);
  await expect(call('agent.start', { draft_id: draftId, brief: ' ' })).rejects.toThrow();
  await expect(call('agent.start', { draft_id: 'nope', brief: 'x' })).rejects.toThrow();
});

it('rejects anything outside the method table', async () => {
  await expect(call('toString', undefined)).rejects.toThrow('Unknown method: toString');
  await expect(call('drafts.delete', undefined)).rejects.toThrow('Unknown method');
});

it('keeps a draft linked to the Music preview read-only for the user and Claude', async () => {
  const draftId = randomUUID();
  const store = base.drafts!();

  store.create(draftId, 'Linked', ['T-TEARDROP', 'T-ROADS']);
  store.claimPreview(draftId, 1, true);

  const linked = /linked to the Selecta Preview playlist/;

  expect(await call('drafts.edit', { draft_id: draftId, revision: 1, name: 'x' })).toMatchObject({
    error: 'preview_conflict',
  });
  await call('agent.start', { draft_id: draftId, brief: 'go' });
  await call('agent.send', { draft_id: draftId, message: 'go', text: 'typed' });
  expect(agent.refuse).toHaveBeenCalledWith(draftId, 'go', expect.stringMatching(linked));
  expect(agent.refuse).toHaveBeenCalledWith(draftId, 'typed', expect.stringMatching(linked));
  expect(agent.start).not.toHaveBeenCalled();
  expect(agent.send).not.toHaveBeenCalled();
  expect(store.get(draftId).revision).toBe(1);
});

it('fills the crate newest first, or by relevance to a search, with provenance', async () => {
  const all = (await call('library.crate', {})) as {
    tracks: { persistent_id: string; title: string }[];
    total: number;
    order: string;
  };

  expect(all.order).toBe('recently_added');
  expect(all.tracks.length).toBe(all.total);

  const found = (await call('library.crate', { query: 'teardrop' })) as typeof all;

  expect(found).toMatchObject({ order: 'relevance', tracks: [{ title: 'Teardrop' }] });
  await expect(call('library.crate', { query: 'x'.repeat(201) })).rejects.toThrow();
  await expect(call('library.crate', { sort: 'random' })).rejects.toThrow();
});
