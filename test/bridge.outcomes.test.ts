import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridge, listLibraryTrackIds } from '../src/bridge/index.js';
import { runJxa } from '../src/bridge/jxa.js';

vi.mock('../src/bridge/jxa.js', () => ({ runJxa: vi.fn() }));
afterEach(() => vi.clearAllMocks());

const writes = [
  { name: 'create', invoke: () => bridge.createPlaylist({ name: 'Mix', trackIds: ['A', 'B'] }) },
  { name: 'replace', invoke: () => bridge.replacePlaylist({ name: 'Mix', trackIds: ['A', 'B'] }) },
  {
    name: 'clone',
    invoke: () => bridge.clonePlaylist({ name: 'Mix', sourcePlaylistId: 'SOURCE' }),
  },
];

describe.each(writes)('$name validated outcomes', ({ name, invoke }) => {
  it.each([
    { trackPersistentIds: undefined },
    { trackPersistentIds: [] },
    { trackPersistentIds: ['B', 'A', 'A'] },
  ])('preserves partial receipts with observed tracks %j', async ({ trackPersistentIds }) => {
    vi.mocked(runJxa).mockResolvedValue({
      partialWrite: {
        persistentId: 'PARTIAL',
        ...(trackPersistentIds ? { trackPersistentIds } : {}),
      },
    });
    const outcome = invoke();

    await expect(outcome).rejects.toMatchObject({
      errorCode: 'jxa_error',
      message: 'Playlist write or readback failed after selecting the target',
      hint: expect.stringContaining('Do not repeat the create or overwrite blindly'),
    });
    await expect(outcome).rejects.toHaveProperty('partialWrite', {
      playlist_id: 'PARTIAL',
      ...(trackPersistentIds ? { observed_track_ids: trackPersistentIds } : {}),
    });
    expect(runJxa).toHaveBeenCalledOnce();
  });

  it.each([
    { partialWrite: null },
    { partialWrite: { persistentId: '' } },
    { partialWrite: { persistentId: 'P', trackPersistentIds: [123] } },
    { missingTrackIds: [] },
    // Otherwise valid for each write operation: trackCount disagrees with the one observed ID.
    {
      persistentId: 'P',
      trackCount: 2,
      trackPersistentIds: ['A'],
      created: false,
      sourcePersistentId: 'SOURCE',
      sourceName: 'Source',
      sourceTrackPersistentIds: ['A'],
    },
  ])('rejects malformed responses at the Music.app boundary: %j', async (payload) => {
    vi.mocked(runJxa).mockResolvedValue(payload);
    await expect(invoke()).rejects.toMatchObject({
      errorCode: 'jxa_error',
      message: expect.stringContaining('Music.app: invalid payload'),
      partialWrite:
        name === 'replace'
          ? undefined
          : 'persistentId' in payload
            ? { playlist_id: 'P', observed_track_ids: ['A'] }
            : payload.partialWrite?.persistentId === 'P'
              ? { playlist_id: 'P' }
              : undefined,
    });
  });

  it('returns the observed destination, preserving intentional duplicates and operation fields', async () => {
    const expected = {
      persistentId: 'DEST',
      trackCount: 3,
      trackPersistentIds: ['B', 'A', 'A'],
      ...(name === 'replace' ? { created: false } : {}),
      ...(name === 'clone'
        ? {
            sourcePersistentId: 'SOURCE',
            sourceName: 'Source',
            sourceTrackPersistentIds: ['A', 'B'],
          }
        : {}),
    };

    vi.mocked(runJxa).mockResolvedValue({ ...expected, extra: 'ignored' });
    await expect(invoke()).resolves.toEqual(expected);
  });
});

const signals = [
  {
    name: 'loved',
    row: (persistentId: string) => ({ persistentId, loved: false }),
    invoke: (trackIds: string[]) => bridge.setTrackLoved({ trackIds, loved: true }),
    malformedRow: { persistentId: 'A', loved: 1 },
  },
  {
    name: 'rating',
    row: (persistentId: string) => ({ persistentId, rating: null }),
    invoke: (trackIds: string[]) => bridge.setTrackRating({ trackIds, rating: 80 }),
    malformedRow: { persistentId: 'A', rating: 101 },
  },
];

describe.each(signals)('$name signal outcomes', ({ row, invoke, malformedRow }) => {
  describe.each(['tracks', 'preWriteTracks'])('%s coverage', (field) => {
    it.each([
      { reason: 'incomplete', ids: ['A'] },
      { reason: 'duplicate', ids: ['A', 'A'] },
      { reason: 'unexpected', ids: ['A', 'C'] },
    ])('rejects $reason IDs even when the payload is structurally valid', async ({ ids }) => {
      vi.mocked(runJxa).mockResolvedValue({
        tracks: ['A', 'B'].map(row),
        preWriteTracks: ['A', 'B'].map(row),
        [field]: ids.map(row),
      });
      await expect(invoke(['A', 'B'])).rejects.toMatchObject({
        errorCode: 'jxa_error',
        message: 'Signal readback IDs differ from requested IDs',
        hint: expect.stringContaining('incomplete or unexpected'),
      });
      expect(runJxa).toHaveBeenCalledOnce();
    });

    it('validates state fields before interpreting the outcome', async () => {
      vi.mocked(runJxa).mockResolvedValue({
        tracks: [row('A')],
        preWriteTracks: [row('A')],
        [field]: [malformedRow],
      });
      await expect(invoke(['A'])).rejects.toMatchObject({
        errorCode: 'jxa_error',
        message: expect.stringContaining('Music.app: invalid payload'),
      });
    });
  });

  it('accepts one observed state per unique requested ID', async () => {
    const expected = { tracks: ['A', 'B'].map(row), preWriteTracks: ['A', 'B'].map(row) };

    vi.mocked(runJxa).mockResolvedValue(expected);
    await expect(invoke(['A', 'B', 'A'])).resolves.toEqual(expected);
  });

  it('keeps missing-track guidance distinct from an incomplete write outcome', async () => {
    vi.mocked(runJxa).mockResolvedValue({ missingTrackIds: ['B'] });
    await expect(invoke(['A', 'B'])).rejects.toMatchObject({
      errorCode: 'track_not_found',
      message: 'Music.app has no tracks with persistent IDs: B',
      hint: expect.stringContaining('cache is stale'),
    });
  });
});

describe('edit and delete outcomes', () => {
  it.each([
    { payload: { orderDrifted: true, liveTrackCount: 3 }, hint: 'playlist_positions' },
    { payload: { invalidOrder: true, liveTrackCount: 3 }, hint: 'every index exactly once' },
  ])('preserves reorder recovery guidance: $payload', async ({ payload, hint }) => {
    vi.mocked(runJxa).mockResolvedValue(payload);
    await expect(
      bridge.reorderPlaylistTracks({
        playlistId: 'P',
        order: [1, 0],
        expectedTrackIds: ['A', 'B'],
      }),
    ).rejects.toMatchObject({
      errorCode: 'validation_error',
      hint: expect.stringContaining(hint),
    });
  });

  it.each([
    {
      name: 'add',
      invoke: () => bridge.addPlaylistTracks({ playlistId: 'P', trackIds: ['A'] }),
      hint: 'not the live library',
    },
    {
      name: 'remove',
      invoke: () => bridge.removePlaylistTracks({ playlistId: 'P', trackIds: ['A'] }),
      hint: 'not in the playlist',
    },
    {
      name: 'replace',
      invoke: () => bridge.replacePlaylist({ name: 'Mix', trackIds: ['A'] }),
      hint: 'cache is stale',
    },
  ])('preserves missing-track guidance for $name', async ({ invoke, hint }) => {
    vi.mocked(runJxa).mockResolvedValue({ missingTrackIds: ['A'] });
    await expect(invoke()).rejects.toMatchObject({
      errorCode: 'track_not_found',
      hint: expect.stringContaining(hint),
    });
  });

  it.each([0, 1])('returns the observed deletion count %i', async (deleted) => {
    vi.mocked(runJxa).mockResolvedValue({ deleted });
    await expect(bridge.deletePlaylistById('P')).resolves.toBe(deleted);
  });

  it('preserves the non-editable deletion sentinel', async () => {
    vi.mocked(runJxa).mockResolvedValue({ notEditable: true });
    await expect(bridge.deletePlaylistById('P')).rejects.toMatchObject({
      errorCode: 'playlist_not_editable',
      message: 'Target is not a plain user playlist.',
    });
  });

  it.each([null, {}, { deleted: '1' }, { notEditable: false }])(
    'rejects malformed deletion results: %j',
    async (payload) => {
      vi.mocked(runJxa).mockResolvedValue(payload);
      await expect(bridge.deletePlaylistById('P')).rejects.toMatchObject({
        errorCode: 'jxa_error',
        message: expect.stringContaining('Music.app: invalid payload'),
      });
    },
  );
});

describe('track ID list boundary', () => {
  it.each([{ ids: [] }, { ids: ['A', 'B'] }])('returns validated IDs: $ids', async ({ ids }) => {
    vi.mocked(runJxa).mockResolvedValue(ids);
    await expect(listLibraryTrackIds()).resolves.toEqual(ids);
  });

  it.each([null, { ids: ['A'] }, ['A', 123], ['']].map((ids) => ({ ids })))(
    'rejects malformed IDs: $ids',
    async ({ ids }) => {
      vi.mocked(runJxa).mockResolvedValue(ids);
      await expect(listLibraryTrackIds()).rejects.toMatchObject({
        errorCode: 'jxa_error',
        message: expect.stringContaining('Music.app: invalid payload'),
      });
    },
  );
});
