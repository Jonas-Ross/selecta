import { beforeEach, expect, it, vi } from 'vitest';
import { bridge } from '../src/bridge/index.js';
import { runJxa } from '../src/bridge/jxa.js';
import { BridgeError } from '../src/types/errors.js';

vi.mock('../src/bridge/jxa.js', () => ({ runJxa: vi.fn() }));
const run = vi.mocked(runJxa);

beforeEach(() => run.mockReset());

it('marks a validated missing-track creation guard as pre-write', async () => {
  run.mockResolvedValue({ missingTrackIds: ['T-MISSING'] });
  await expect(
    bridge.createPlaylist({ name: 'Mix', trackIds: ['T-MISSING'] }),
  ).rejects.toMatchObject({ errorCode: 'track_not_found', writePhase: 'not_started' });
  expect(run).toHaveBeenCalledTimes(1);
});

it.each([
  { playlistNotFound: true },
  { ambiguousSource: { name: 'Selecta Preview', persistentIds: ['P-A', 'P-B'] } },
  { sourceNotUser: true, sourceKind: 'smart' },
  { invalidSourceTrackCount: 0 },
  { missingTrackIds: ['T-MISSING'] },
])('marks the validated clone guard %j as pre-write', async (payload) => {
  run.mockResolvedValue(payload);
  await expect(
    bridge.clonePlaylist({ name: 'Mix', sourcePlaylistId: 'P-SOURCE' }),
  ).rejects.toMatchObject({ writePhase: 'not_started' });
  expect(run).toHaveBeenCalledTimes(1);
});

it('marks the reserved-preview missing guard as pre-write', async () => {
  run.mockResolvedValue({ playlistNotFound: true });
  await expect(
    bridge.clonePlaylist({
      name: 'Mix',
      sourcePlaylistId: 'P-SOURCE',
      reservedSourceName: 'Selecta Preview',
    }),
  ).rejects.toMatchObject({ writePhase: 'not_started' });
});

it.each(['create', 'clone'] as const)(
  'does not mark partial, invalid, or executor failures as pre-write for %s',
  async (mode) => {
    const call = () =>
      mode === 'create'
        ? bridge.createPlaylist({ name: 'Mix', trackIds: ['T-A'] })
        : bridge.clonePlaylist({ name: 'Mix', sourcePlaylistId: 'P-SOURCE' });

    for (const payload of [
      {
        partialWrite: {
          persistentId: 'P-PARTIAL',
          message: 'population failed',
          trackPersistentIds: ['T-A'],
        },
      },
      { missingTrackIds: 'invalid guard' },
      {},
    ]) {
      run.mockResolvedValueOnce(payload);
      await expect(call()).rejects.toMatchObject({ errorCode: 'jxa_error', writePhase: undefined });
    }

    run.mockRejectedValueOnce(new BridgeError('automation_permission_denied', 'lost permission'));
    await expect(call()).rejects.toMatchObject({
      errorCode: 'automation_permission_denied',
      writePhase: undefined,
    });
    expect(run).toHaveBeenCalledTimes(4);
  },
);

it.each(['create', 'clone'] as const)(
  'does not prove pre-write for contradictory %s guard and destination evidence',
  async (mode) => {
    const call = () =>
      mode === 'create'
        ? bridge.createPlaylist({ name: 'Mix', trackIds: ['T-A'] })
        : bridge.clonePlaylist({ name: 'Mix', sourcePlaylistId: 'P-SOURCE' });

    run.mockResolvedValueOnce({
      missingTrackIds: ['T-MISSING'],
      partialWrite: { persistentId: 'P-PARTIAL' },
    });
    await expect(call()).rejects.toMatchObject({
      errorCode: 'jxa_error',
      writePhase: undefined,
      partialWrite: { playlist_id: 'P-PARTIAL' },
    });
    run.mockResolvedValueOnce({ missingTrackIds: ['T-MISSING'], persistentId: 'P-CREATED' });
    await expect(call()).rejects.toMatchObject({ errorCode: 'jxa_error', writePhase: undefined });
    run.mockResolvedValueOnce({
      missingTrackIds: ['T-MISSING'],
      partialWrite: { persistentId: '' },
    });
    await expect(call()).rejects.toMatchObject({ errorCode: 'jxa_error', writePhase: undefined });
  },
);

it.each([
  { playlistNotFound: true },
  { ambiguousSource: { name: 'Selecta Preview', persistentIds: ['P-A', 'P-B'] } },
  { sourceNotUser: true, sourceKind: 'smart' },
  { invalidSourceTrackCount: 0 },
  { missingTrackIds: ['T-MISSING'] },
])('preserves clone target evidence mixed with %j', async (guard) => {
  const call = () => bridge.clonePlaylist({ name: 'Mix', sourcePlaylistId: 'P-SOURCE' });

  run.mockResolvedValueOnce({
    ...guard,
    partialWrite: { persistentId: 'P-PARTIAL', trackPersistentIds: [] },
  });
  await expect(call()).rejects.toMatchObject({
    writePhase: undefined,
    partialWrite: { playlist_id: 'P-PARTIAL', observed_track_ids: [] },
  });
  run.mockResolvedValueOnce({ ...guard, persistentId: 'P-INCOMPLETE' });
  await expect(call()).rejects.toMatchObject({
    writePhase: undefined,
    partialWrite: { playlist_id: 'P-INCOMPLETE' },
  });
  const success = {
    persistentId: 'P-CREATED',
    trackCount: 2,
    trackPersistentIds: ['T-A', 'T-A'],
    sourcePersistentId: 'P-SOURCE',
    sourceName: 'Source',
    sourceTrackPersistentIds: ['T-A'],
  };

  run.mockResolvedValueOnce({ ...guard, ...success });
  await expect(call()).resolves.toEqual(success);
});

it.each([
  { trackPersistentIds: ['T-A', 'T-A'], expected: ['T-A', 'T-A'] },
  { trackPersistentIds: [], expected: [] },
  { trackPersistentIds: ['T-A', 17], expected: undefined },
  { trackPersistentIds: undefined, expected: undefined },
])(
  'preserves only validated observed IDs in incomplete creation diagnostics: %j',
  async ({ trackPersistentIds, expected }) => {
    run.mockResolvedValueOnce({ persistentId: 'P-KNOWN', trackPersistentIds });
    const result = bridge.createPlaylist({ name: 'Mix', trackIds: ['T-A'] });

    await expect(result).rejects.toMatchObject({ errorCode: 'jxa_error', writePhase: undefined });
    await expect(result).rejects.toHaveProperty('partialWrite', {
      playlist_id: 'P-KNOWN',
      ...(expected !== undefined ? { observed_track_ids: expected } : {}),
    });
  },
);

it('keeps unrelated guard extras compatible and does not change replace or signal proof', async () => {
  run.mockResolvedValueOnce({ missingTrackIds: ['T-A'], extra: 'ignored' });
  await expect(bridge.createPlaylist({ name: 'Mix', trackIds: ['T-A'] })).rejects.toMatchObject({
    writePhase: 'not_started',
  });
  run.mockResolvedValueOnce({ missingTrackIds: ['T-A'], persistentId: 'unrelated' });
  await expect(bridge.replacePlaylist({ name: 'Mix', trackIds: ['T-A'] })).rejects.toMatchObject({
    errorCode: 'track_not_found',
    writePhase: undefined,
  });
  run.mockResolvedValueOnce({ missingTrackIds: ['T-A'] });
  await expect(bridge.setTrackLoved({ trackIds: ['T-A'], loved: true })).rejects.toMatchObject({
    errorCode: 'track_not_found',
    writePhase: undefined,
  });
});

it('preserves successful create readback mixed with a guard and empty partial observations', async () => {
  const success = { persistentId: 'P-CREATED', trackCount: 2, trackPersistentIds: ['T-A', 'T-A'] };

  run.mockResolvedValueOnce({ missingTrackIds: ['T-MISSING'], ...success });
  await expect(bridge.createPlaylist({ name: 'Mix', trackIds: ['T-A'] })).resolves.toEqual(success);
  run.mockResolvedValueOnce({
    missingTrackIds: ['T-MISSING'],
    partialWrite: { persistentId: 'P-PARTIAL', trackPersistentIds: [] },
  });
  await expect(bridge.createPlaylist({ name: 'Mix', trackIds: ['T-A'] })).rejects.toMatchObject({
    writePhase: undefined,
    partialWrite: { playlist_id: 'P-PARTIAL', observed_track_ids: [] },
  });
});

it.each(['create', 'clone'] as const)(
  'does not promote mixed success and malformed partial evidence to %s success',
  async (mode) => {
    run.mockResolvedValueOnce({
      persistentId: 'P-CREATED',
      trackCount: 1,
      trackPersistentIds: ['T-A'],
      sourcePersistentId: 'P-SOURCE',
      sourceName: 'Source',
      sourceTrackPersistentIds: ['T-A'],
      partialWrite: { persistentId: 'P-PARTIAL', trackPersistentIds: [17] },
    });
    const result =
      mode === 'create'
        ? bridge.createPlaylist({ name: 'Mix', trackIds: ['T-A'] })
        : bridge.clonePlaylist({ name: 'Mix', sourcePlaylistId: 'P-SOURCE' });

    await expect(result).rejects.toMatchObject({ errorCode: 'jxa_error', writePhase: undefined });
    await expect(result).rejects.toHaveProperty('partialWrite', { playlist_id: 'P-PARTIAL' });
  },
);

it.each([{ trackCount: 1 }, { trackPersistentIds: ['T-A'] }])(
  'does not prove pre-write when a guard contains destination data without identity: %j',
  async (evidence) => {
    run.mockResolvedValueOnce({ missingTrackIds: ['T-MISSING'], ...evidence });
    await expect(
      bridge.createPlaylist({ name: 'Mix', trackIds: ['T-MISSING'] }),
    ).rejects.toMatchObject({
      errorCode: 'jxa_error',
      writePhase: undefined,
      partialWrite: undefined,
    });
  },
);
