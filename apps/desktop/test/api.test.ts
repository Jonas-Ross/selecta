import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { DraftStore } from '@selecta/core/drafts/store.js';
import { makeToolDeps } from '../../../packages/core/test/helpers.js';
import { createApi } from '../src/host/api.js';
import type { AgentSessions } from '../src/host/agent.js';
import type { ProviderStatus } from '../src/shared/protocol.js';

const base = makeToolDeps();
const store = new DraftStore(base.drafts!().path);
const deps = { ...base, drafts: () => store };
const agent = {
  start: vi.fn(),
  send: vi.fn(),
  refuse: vi.fn(),
  cancel: vi.fn(),
  history: vi.fn(() => ({})),
  provider: vi.fn(() => ({ label: 'Codex' })),
  suggest: vi.fn<(draftId: string, prompt: string, provider?: string) => Promise<string>>(
    async () => '',
  ),
  stopSuggest: vi.fn(),
  brief: vi.fn((): string | undefined => 'Late night, slow'),
};
const artwork = {
  get: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, null]))),
};
const providers = vi.fn(async (): Promise<ProviderStatus[]> => [
  { id: 'codex', label: 'Codex', ready: true },
]);
const call = createApi(deps, agent as unknown as AgentSessions, artwork, providers);

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

  await call('agent.start', { draft_id: draftId, brief: 'techno', provider: 'codex' });
  await call('agent.send', { draft_id: draftId, message: 'faster', provider: 'codex' });

  expect(agent.start).toHaveBeenCalledWith(draftId, 'deep house', undefined);
  expect(agent.start).toHaveBeenCalledWith(draftId, 'techno', 'codex');
  expect(agent.send).toHaveBeenCalledWith(draftId, 'slower', 'typed', undefined);
  expect(agent.send).toHaveBeenCalledWith(draftId, 'faster', undefined, 'codex');
  expect(agent.send).toHaveBeenCalledTimes(3);
  expect(await call('agent.providers', undefined)).toEqual([
    { id: 'codex', label: 'Codex', ready: true },
  ]);
  await expect(
    call('agent.start', { draft_id: draftId, brief: 'x', provider: 'gemini' }),
  ).rejects.toThrow();
  expect(agent.cancel).toHaveBeenCalledWith(draftId);
  await expect(call('agent.start', { draft_id: draftId, brief: ' ' })).rejects.toThrow();
  await expect(call('agent.start', { draft_id: 'nope', brief: 'x' })).rejects.toThrow();
});

it('rejects anything outside the method table', async () => {
  await expect(call('toString', undefined)).rejects.toThrow('Unknown method: toString');
  await expect(call('drafts.delete', undefined)).rejects.toThrow('Unknown method');
});

it('lets the user edit a draft linked to the Music preview, but not the agent', async () => {
  const draftId = randomUUID();

  store.create(draftId, 'Linked', ['T-TEARDROP', 'T-ROADS']);
  store.claimPreview(draftId, 1, true);

  const linked = /^Codex can't edit this draft while it plays through the Selecta Preview playlist/;

  expect(await call('drafts.edit', { draft_id: draftId, revision: 1, name: 'x' })).toMatchObject({
    local_edit_saved: true,
    draft: { revision: 2 },
  });
  await call('agent.start', { draft_id: draftId, brief: 'go' });
  await call('agent.send', { draft_id: draftId, message: 'go', text: 'typed' });
  expect(agent.refuse).toHaveBeenCalledWith(draftId, 'go', expect.stringMatching(linked), true);
  expect(agent.refuse).toHaveBeenCalledWith(draftId, 'typed', expect.stringMatching(linked));
  expect(agent.start).not.toHaveBeenCalled();
  expect(agent.send).not.toHaveBeenCalled();

  // After a restart the host has no choice on record; the one asked for names the refusal.
  await call('agent.send', { draft_id: draftId, message: 'go', provider: 'claude' });
  expect(agent.refuse).toHaveBeenLastCalledWith(
    draftId,
    'go',
    expect.stringMatching(/^Claude can't edit this draft/),
  );
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

it('hands artwork lookups to the cache only within the request limit', async () => {
  const id = '0123456789ABCDEF';

  expect(await call('artwork.get', { track_ids: [id] })).toEqual({ [id]: null });
  expect(artwork.get).toHaveBeenCalledWith([id], undefined);
  await call('artwork.get', { track_ids: [id], refresh: [id] });
  expect(artwork.get).toHaveBeenLastCalledWith([id], [id]);
  await expect(call('artwork.get', { track_ids: Array(201).fill(id) })).rejects.toThrow();
  await expect(call('artwork.get', { track_ids: [id], size: 'large' })).rejects.toThrow();
  await expect(call('artwork.get', { track_ids: 'all' })).rejects.toThrow();
  expect(artwork.get).toHaveBeenCalledTimes(2);
});

it('asks the agent for stand-ins and keeps only library tracks the draft and the ask leave out', async () => {
  const draftId = randomUUID();
  const draft = deps.drafts().create(draftId, 'Night', ['T-TEARDROP', 'T-ROADS', 'T-ANGEL']);
  const roads = draft.entries[1]!.entry_id;

  agent.suggest.mockResolvedValueOnce(
    `Some picks.\n${JSON.stringify({
      picks: [
        { track_id: 'T-ANGEL', reason: 'Already in the draft' },
        { track_id: 'T-GLORYBOX', reason: 'Slow and smoky.' },
        { track_id: 'T-NOWHERE', reason: 'Not in the library' },
        { track_id: 'T-GLORYBOX', reason: 'Twice' },
        { track_id: 'T-BARE', reason: 'Asked to leave out' },
        { track_id: 'T-MIDNIGHT', reason: 'Close in tempo.' },
      ],
    })}`,
  );

  const picks = (await call('agent.suggest', {
    draft_id: draftId,
    entry_id: roads,
    ask: 'more vocal',
    exclude: ['T-BARE'],
    provider: 'codex',
  })) as { track: { persistent_id: string; title: string }; reason: string }[];

  expect(picks.map((pick) => [pick.track.persistent_id, pick.reason])).toEqual([
    ['T-GLORYBOX', 'Slow and smoky.'],
    ['T-MIDNIGHT', 'Close in tempo.'],
  ]);

  const [id, prompt, provider] = agent.suggest.mock.calls[0]!;

  expect(id).toBe(draftId);
  expect(provider).toBe('codex');
  expect(prompt).toContain('record 2 of 3: "Roads" by Portishead (track ID T-ROADS)');
  expect(prompt).toContain('Late night, slow');
  expect(prompt).toContain('leave these out: T-BARE');
  expect(prompt).toContain('more vocal');
});

it('says so when the agent offers nothing usable, or the record has gone', async () => {
  const draftId = randomUUID();
  const draft = deps.drafts().create(draftId, 'Night', ['T-TEARDROP']);

  agent.suggest.mockResolvedValueOnce('No luck, sorry.');
  await expect(
    call('agent.suggest', { draft_id: draftId, entry_id: draft.entries[0]!.entry_id }),
  ).rejects.toThrow("Codex didn't find a stand-in.");
  await expect(
    call('agent.suggest', { draft_id: draftId, entry_id: randomUUID() }),
  ).rejects.toThrow('That record is no longer in the draft.');
  await expect(
    call('agent.suggest', {
      draft_id: draftId,
      entry_id: draft.entries[0]!.entry_id,
      ask: 'x'.repeat(501),
    }),
  ).rejects.toThrow();
  expect(agent.suggest).toHaveBeenCalledTimes(1);

  await call('agent.stopSuggest', { draft_id: draftId });
  expect(agent.stopSuggest).toHaveBeenCalledWith(draftId);
});

it('auditions at most a record and its two neighbours, from a place among them', async () => {
  await expect(call('player.audition', { track_ids: [], index: 0 })).rejects.toThrow();
  await expect(
    call('player.audition', { track_ids: ['A', 'B', 'C', 'D'], index: 1 }),
  ).rejects.toThrow();
  await expect(call('player.audition', { track_ids: ['A', 'B'], index: 2 })).rejects.toThrow(
    'Nothing to play at that place.',
  );
  // Unknown to the cache, so nothing reaches Music.app.
  await expect(call('player.audition', { track_ids: ['T-NOWHERE'], index: 0 })).rejects.toThrow(
    /track_not_found/,
  );
});
