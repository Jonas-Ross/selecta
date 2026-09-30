import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { makeToolDeps } from '../../../packages/core/test/helpers.js';
import { createApi } from '../src/host/api.js';
import type { AgentSessions } from '../src/host/agent.js';

const deps = makeToolDeps();
const agent = { start: vi.fn(), send: vi.fn(), cancel: vi.fn() };
const call = createApi({ ...deps, drafts: deps.drafts! }, agent as unknown as AgentSessions);

afterEach(() => vi.clearAllMocks());

it('lists, reads and edits drafts through the same handlers as the MCP tools', async () => {
  const draftId = randomUUID();

  deps.drafts!().create(draftId, 'Warmup', ['T-TEARDROP', 'T-ROADS']);

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
  await call('agent.send', { draft_id: draftId, message: 'slower' });
  await call('agent.send', { draft_id: draftId, message: 'x'.repeat(50_000) });
  await call('agent.cancel', { draft_id: draftId });

  expect(agent.start).toHaveBeenCalledWith(draftId, 'deep house');
  expect(agent.send).toHaveBeenCalledWith(draftId, 'slower');
  expect(agent.send).toHaveBeenCalledTimes(2);
  expect(agent.cancel).toHaveBeenCalledWith(draftId);
  await expect(call('agent.start', { draft_id: draftId, brief: ' ' })).rejects.toThrow();
  await expect(call('agent.start', { draft_id: 'nope', brief: 'x' })).rejects.toThrow();
});

it('rejects anything outside the method table', async () => {
  await expect(call('toString', undefined)).rejects.toThrow('Unknown method: toString');
  await expect(call('drafts.delete', undefined)).rejects.toThrow('Unknown method');
});
