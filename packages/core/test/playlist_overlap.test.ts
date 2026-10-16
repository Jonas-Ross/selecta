// How much of a tracklist repeats one of the user's own playlists, and why
// Selecta's scratch slot never counts as one.

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import { handleInspectTracklist } from '../src/tools/inspect_tracklist.js';
import { handleGetTrackContext } from '../src/tools/get_track_context.js';
import { PlaylistDraftTools } from '../src/tools/playlist_draft.js';
import type { LibrarySnapshot } from '../src/types/bridge.js';
import { makeBridge, makeDraftStore } from './helpers.js';

const snapshot: LibrarySnapshot = {
  capturedAt: '2026-10-16T00:00:00.000Z',
  tracks: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'].map((persistentId) => ({
    persistentId,
    title: persistentId,
    artist: `Artist ${persistentId}`,
  })),
  playlists: [
    {
      persistentId: 'P-CHILL',
      name: 'Chill Vibes',
      kind: 'user',
      trackPersistentIds: ['T1', 'T2', 'T3', 'T4'],
    },
    {
      persistentId: 'P-BIG',
      name: 'Everything',
      kind: 'user',
      trackPersistentIds: ['T1', 'T2', 'T5', 'T6', 'T7'],
    },
    { persistentId: 'P-ONE', name: 'One Shared', kind: 'user', trackPersistentIds: ['T5', 'T6'] },
    {
      persistentId: 'P-SMART',
      name: 'Smart',
      kind: 'smart',
      trackPersistentIds: ['T1', 'T2', 'T3', 'T5'],
    },
    {
      persistentId: 'P-PREVIEW',
      name: 'Selecta Preview',
      kind: 'user',
      trackPersistentIds: ['T1', 'T2', 'T3', 'T5', 'T8'],
    },
  ],
};

function makeDeps(bridge = makeBridge()) {
  const cache = SelectaCache.open(':memory:');

  cache.refreshFromSnapshot(snapshot, { durationMs: 1 });

  const drafts = makeDraftStore();

  return { cache: () => cache, bridge, drafts: () => drafts };
}

describe('playlist_overlap', () => {
  it('reports user playlists holding at least two distinct tracks, the nearest copy first', async () => {
    const result = await handleInspectTracklist(
      { track_ids: ['T1', 'T2', 'T3', 'T5', 'T1'] },
      makeDeps(),
    );

    expect(result).toMatchObject({
      playlist_overlap: [
        {
          playlist_id: 'P-CHILL',
          name: 'Chill Vibes',
          shared_tracks: 3,
          playlist_tracks: 4,
          draft_share: 0.75,
        },
        {
          playlist_id: 'P-BIG',
          name: 'Everything',
          shared_tracks: 3,
          playlist_tracks: 5,
          draft_share: 0.75,
        },
      ],
    });
  });

  it('is empty when no user playlist holds two of the tracks', async () => {
    const result = await handleInspectTracklist({ track_ids: ['T4', 'T6', 'T8'] }, makeDeps());

    expect(result).toMatchObject({ playlist_overlap: [] });
  });

  it("leaves out a saved draft's own playlist", async () => {
    const deps = makeDeps(
      makeBridge({
        createPlaylist: vi.fn(async ({ trackIds }) => ({
          persistentId: 'P-SAVED',
          trackCount: trackIds.length,
          trackPersistentIds: trackIds,
        })),
      }),
    );
    const tools = new PlaylistDraftTools(deps);
    const draftId = randomUUID();

    await tools.show({ draft_id: draftId, name: 'Mix', track_ids: ['T3', 'T4'] });
    await tools.save({ draft_id: draftId, revision: 1 });

    expect(deps.cache().getPlaylist('P-SAVED')).not.toBeNull();
    expect(await tools.get({ draft_id: draftId })).toMatchObject({
      inspection: {
        playlist_overlap: [{ playlist_id: 'P-CHILL', shared_tracks: 2 }],
      },
    });
  });
});

describe('Selecta Preview', () => {
  it('never counts as a co-occurrence source', async () => {
    const result = await handleGetTrackContext({ track_id: 'T8' }, makeDeps());

    expect(result).toMatchObject({
      co_occurring_tracks: [],
      source_playlists: { considered: 0, excluded: 0 },
    });
  });
});
