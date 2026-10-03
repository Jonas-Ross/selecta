import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Draft } from '@selecta/core/drafts/contracts.js';
import type { PlayerState } from '@selecta/core/types/bridge.js';
import { withOperation } from '@selecta/core/operations/lock.js';
import { BridgeError } from '@selecta/core/types/errors.js';
import { PlaylistDraftTools } from '@selecta/core/tools/playlist_draft.js';
import { makeToolDeps } from '../../../packages/core/test/helpers.js';
import { createPlayer, inStep, playerView } from '../src/host/player.js';

const A = 'T-TEARDROP';
const B = 'T-ROADS';
const PREVIEW = { persistentId: 'P-SLOT', name: 'Selecta Preview' };
const playing = (index: number, persistentId: string): PlayerState => ({
  running: true,
  state: 'playing',
  track: { persistentId, duration: 300 },
  position: 12,
  index,
  playlist: PREVIEW,
});

let deps: ReturnType<typeof makeToolDeps>;
let player: ReturnType<typeof createPlayer>;

beforeEach(() => {
  deps = makeToolDeps({
    replacePlaylist: vi.fn(async ({ trackIds }) => ({
      persistentId: 'P-SLOT',
      trackCount: trackIds.length,
      trackPersistentIds: trackIds,
      created: false,
    })),
    playPreview: vi.fn(async ({ expectedTrackIds, index }) => ({
      playlistId: 'P-SLOT',
      player: playing(index + 1, expectedTrackIds[index]),
    })),
    readPlayer: vi.fn(async () => playing(3, A)),
    controlPlayer: vi.fn(async () => ({ ...playing(3, A), state: 'paused' })),
  });

  const tools = new PlaylistDraftTools(deps);

  player = createPlayer({
    bridge: deps.bridge,
    cache: deps.cache,
    drafts: deps.drafts!,
    preview: (args) => tools.preview(args),
  });
});
afterEach(() => deps.cacheInstance.close());

function draft(ids = [A, B, A]): Draft {
  return deps.drafts!().create(randomUUID(), 'Set', ids);
}

it('loads the draft into the preview once, then plays the chosen entry from it', async () => {
  const { draft_id, entries } = draft();

  expect(await player.play(draft_id, 1, entries[2].entry_id)).toMatchObject({
    state: 'playing',
    entry_id: entries[2].entry_id,
  });
  expect(deps.bridge.replacePlaylist).toHaveBeenCalledOnce();
  expect(deps.bridge.playPreview).toHaveBeenLastCalledWith({
    expectedTrackIds: [A, B, A],
    index: 2,
    restart: true,
  });

  await player.play(draft_id, 1, entries[1].entry_id, 255);
  expect(deps.bridge.replacePlaylist).toHaveBeenCalledOnce();
  expect(deps.bridge.playPreview).toHaveBeenLastCalledWith({
    expectedTrackIds: [A, B, A],
    index: 1,
    position: 255,
  });
});

it('starts the playlist over unless it started the queue Music.app is still on', async () => {
  const { draft_id, entries } = draft();
  const restarts = () =>
    vi.mocked(deps.bridge.playPreview).mock.calls.map(([input]) => input.restart === true);

  // Music.app already on the entry, as a lone track would leave it, still gets a restart.
  await player.play(draft_id, 1, entries[2].entry_id);
  await player.play(draft_id, 1, entries[2].entry_id, 200);
  vi.mocked(deps.bridge.readPlayer).mockResolvedValueOnce({ running: true, state: 'stopped' });
  await player.play(draft_id, 1, entries[0].entry_id);
  vi.mocked(deps.bridge.readPlayer).mockResolvedValueOnce({
    ...playing(1, A),
    playlist: { persistentId: 'P-OTHER', name: 'Mine' },
  });
  await player.play(draft_id, 1, entries[0].entry_id);
  expect(restarts()).toEqual([true, false, true, true]);
});

it('plays nothing when the preview could not be loaded in order', async () => {
  const { draft_id, entries } = draft();

  vi.mocked(deps.bridge.replacePlaylist).mockRejectedValueOnce(new Error('Music.app went away'));
  await expect(player.play(draft_id, 1, entries[0].entry_id)).rejects.toThrow();
  expect(deps.bridge.playPreview).not.toHaveBeenCalled();
});

it('refuses a stale revision or a missing entry before touching Music.app', async () => {
  const { draft_id, entries } = draft();

  await expect(player.play(draft_id, 2, entries[0].entry_id)).rejects.toThrow(/changed/);
  await expect(player.play(draft_id, 1, randomUUID())).rejects.toThrow(/no longer/);
  expect(deps.bridge.replacePlaylist).not.toHaveBeenCalled();
});

it('names the playing entry by its place in the preview, so repeats stay apart', async () => {
  const { draft_id, entries } = draft();

  await player.play(draft_id, 1, entries[0].entry_id);
  expect((await player.state(draft_id)).entry_id).toBe(entries[2].entry_id);
  expect(await player.control(draft_id, { action: 'pause' })).toMatchObject({
    state: 'paused',
    entry_id: entries[2].entry_id,
  });
  expect(deps.bridge.controlPlayer).toHaveBeenCalledWith({
    action: 'pause',
    on: { playlistId: 'P-SLOT', index: 3, trackId: A },
  });
});

it('detaches the preview so the draft is local again', async () => {
  const { draft_id, entries } = draft();

  await player.play(draft_id, 1, entries[0].entry_id);
  await player.detach(draft_id, 1);
  expect(deps.bridge.controlPlayer).toHaveBeenCalledWith({
    action: 'pause',
    on: { playlistId: 'P-SLOT', index: 3, trackId: A },
  });
  expect(deps.drafts!().preview()?.status).toBe('inactive');
  expect((await player.state(draft_id)).entry_id).toBeUndefined();
});

it('follows the slot when Music.app gives the preview a new ID', async () => {
  const { draft_id, entries } = draft();

  vi.mocked(deps.bridge.playPreview).mockImplementation(async ({ expectedTrackIds, index }) => ({
    playlistId: 'P-REKEYED',
    player: {
      ...playing(index + 1, expectedTrackIds[index]),
      playlist: { persistentId: 'P-REKEYED', name: 'Selecta Preview' },
    },
  }));

  expect((await player.play(draft_id, 1, entries[1].entry_id)).entry_id).toBe(entries[1].entry_id);
  expect(deps.drafts!().preview()?.playlist_id).toBe('P-REKEYED');
});

it('pauses its own preview on stop even when the order is out of step', async () => {
  const { draft_id, entries } = draft();

  await player.play(draft_id, 1, entries[0].entry_id);
  vi.mocked(deps.bridge.readPlayer).mockResolvedValue(playing(2, 'T-OTHER'));
  await player.detach(draft_id, 1);
  expect(deps.bridge.controlPlayer).toHaveBeenCalledWith({
    action: 'pause',
    on: { playlistId: 'P-SLOT', index: 2, trackId: 'T-OTHER' },
  });
});

it('pauses its own preview on stop after iCloud rotates its ID', async () => {
  const { draft_id, entries } = draft();

  await player.play(draft_id, 1, entries[0].entry_id);
  vi.mocked(deps.bridge.readPlayer).mockResolvedValue({
    ...playing(1, A),
    playlist: { persistentId: 'P-ROTATED', name: 'Selecta Preview' },
  });
  await player.detach(draft_id, 1);
  expect(deps.bridge.controlPlayer).toHaveBeenCalledWith({
    action: 'pause',
    on: { playlistId: 'P-ROTATED', index: 1, trackId: A, slot: 'Selecta Preview' },
  });
});

it('still detaches when Music moves off the draft before the pause lands', async () => {
  const { draft_id, entries } = draft();

  await player.play(draft_id, 1, entries[0].entry_id);
  vi.mocked(deps.bridge.controlPlayer).mockRejectedValue(
    new BridgeError('preview_conflict', 'Music.app has moved off that record.'),
  );
  await player.detach(draft_id, 1);
  expect(deps.drafts!().preview()?.status).toBe('inactive');
});

it('stays linked when Music.app will not pause', async () => {
  const { draft_id, entries } = draft();

  await player.play(draft_id, 1, entries[0].entry_id);
  vi.mocked(deps.bridge.controlPlayer).mockRejectedValue(
    new BridgeError('jxa_error', 'Music.app would not pause.'),
  );
  await expect(player.detach(draft_id, 1)).rejects.toThrow(/would not pause/);
  expect(deps.drafts!().preview()?.status).toBe('current');
});

it('refuses transport controls while a preview sync holds the music lock', async () => {
  const { draft_id, entries } = draft();

  await player.play(draft_id, 1, entries[0].entry_id);
  await withOperation(deps.cache(), 'music', async () => {
    await expect(player.control(draft_id, { action: 'pause' })).rejects.toThrow(/Another music/);
  });
  expect(deps.bridge.controlPlayer).not.toHaveBeenCalled();
});

it("won't pause, resume or seek music that isn't this draft", async () => {
  const { draft_id, entries } = draft();

  await player.play(draft_id, 1, entries[0].entry_id);
  vi.mocked(deps.bridge.readPlayer).mockResolvedValue({
    ...playing(1, 'T-OTHER'),
    playlist: { persistentId: 'P-GYM', name: 'Gym' },
  });
  await expect(player.control(draft_id, { action: 'resume' })).rejects.toThrow(/isn't playing/);
  expect(deps.bridge.controlPlayer).not.toHaveBeenCalled();
});

it('leaves Music playing when it has moved off the draft before detaching', async () => {
  const { draft_id, entries } = draft();

  await player.play(draft_id, 1, entries[0].entry_id);
  vi.mocked(deps.bridge.readPlayer).mockResolvedValue({
    ...playing(1, 'T-OTHER'),
    playlist: { persistentId: 'P-GYM', name: 'Gym' },
  });
  await player.detach(draft_id, 1);
  expect(deps.bridge.controlPlayer).not.toHaveBeenCalled();
  expect(deps.drafts!().preview()?.status).toBe('inactive');
});

it('claims an entry only when Music.app is provably in step with this draft', () => {
  const d = draft();
  const slot = {
    generation: randomUUID(),
    version: 1,
    owner: d.draft_id,
    status: 'current' as const,
    playlist_id: 'P-SLOT',
    baseline: [A, B, A],
  };

  expect(inStep(d, slot)).toBe(true);
  expect(inStep(d, { ...slot, status: 'out_of_date' })).toBe(false);
  expect(inStep(d, { ...slot, baseline: [A, B] })).toBe(false);
  expect(inStep(d, { ...slot, owner: randomUUID() })).toBe(false);
  expect(inStep(d, undefined)).toBe(false);

  expect(playerView(playing(2, B), d, slot).entry_id).toBe(d.entries[1].entry_id);
  // The track at that place must be the one playing.
  expect(playerView(playing(2, A), d, slot).entry_id).toBeUndefined();
  expect(playerView({ ...playing(2, B), playlist: undefined }, d, slot).entry_id).toBeUndefined();
  // A copy of the preview playlist shares its name, not its ID.
  expect(
    playerView({ ...playing(2, B), playlist: { ...PREVIEW, persistentId: 'P-COPY' } }, d, slot)
      .entry_id,
  ).toBeUndefined();
  expect(
    playerView(playing(2, B), d, { ...slot, playlist_id: undefined }).entry_id,
  ).toBeUndefined();
  expect(
    playerView({ ...playing(2, B), playlist: { persistentId: 'X', name: 'Gym' } }, d, slot)
      .entry_id,
  ).toBeUndefined();
  expect(playerView({ running: false }, d, slot)).toEqual({ running: false, state: 'stopped' });
  expect(playerView({ running: true, state: 'fast forwarding' }, d, slot).state).toBe('stopped');
});
