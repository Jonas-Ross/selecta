import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bridge } from '@selecta/core/bridge/index.js';
import { runJxa } from '@selecta/core/bridge/jxa.js';
import { MusicSim } from '../harness/music.js';
import { fixtureTracks } from '../harness/library.js';

vi.mock('@selecta/core/bridge/jxa.js', () => ({ runJxa: vi.fn() }));

const tracks = fixtureTracks(6);
const ids = tracks.map((t) => t.persistentId);
let music: MusicSim;

beforeEach(() => {
  music = new MusicSim(tracks);
  music.setSpeed(0);
  vi.mocked(runJxa).mockImplementation(async (script) => JSON.parse(music.run(script)));
});

async function preview(order = ids.slice(0, 4)) {
  await bridge.replacePlaylist({ name: 'Selecta Preview', trackIds: order });

  return order;
}

describe('playing the preview', () => {
  it('starts the playlist and steps to the entry, so Music has a queue to carry on through', async () => {
    const order = await preview();
    const { route, player } = await bridge.playPreview({ expectedTrackIds: order, index: 2 });

    expect(route).toBe('started');
    expect(player).toMatchObject({ state: 'playing', index: 3, track: { persistentId: order[2] } });
    // A pause is resent until one reads back, so repeats are collapsed.
    expect(
      music.calls.filter((call, i) => call !== 'pause' || music.calls[i - 1] !== 'pause'),
    ).toEqual([
      'make Selecta Preview',
      'play Selecta Preview',
      'pause',
      'next',
      'next',
      'seek 0',
      'play',
    ]);
  });

  it('steps within a queue it started rather than starting over', async () => {
    const order = await preview();

    await bridge.playPreview({ expectedTrackIds: order, index: 0 });
    music.calls.length = 0;

    const { route } = await bridge.playPreview({ expectedTrackIds: order, index: 1, position: 60 });

    expect(route).toBe('on from 1');
    expect(music.snapshot().player).toMatchObject({ index: 2, position: expect.closeTo(60, 0) });
    expect(music.calls).not.toContain('play Selecta Preview');
  });

  it('refuses to play shuffled', async () => {
    const order = await preview();

    music.shuffle = true;
    await expect(bridge.playPreview({ expectedTrackIds: order, index: 0 })).rejects.toThrow(
      'Shuffle is on',
    );
    expect(music.calls).not.toContain('play Selecta Preview');
  });

  it('plays nothing when the preview drifted from the draft', async () => {
    const order = await preview();

    await expect(
      bridge.playPreview({ expectedTrackIds: [...order].reverse(), index: 0 }),
    ).rejects.toThrow('differs from this draft');
  });

  it('fails without playing when a Settings window swallows the play', async () => {
    const order = await preview();

    music.settingsOpen = true;
    await expect(bridge.playPreview({ expectedTrackIds: order, index: 1 })).rejects.toThrow();
    expect(music.snapshot().player.state).toBe('stopped');
  });

  it('refuses an ambiguous preview', async () => {
    const order = await preview();

    music.addPlaylist('Selecta Preview', order);
    await expect(bridge.playPreview({ expectedTrackIds: order, index: 0 })).rejects.toThrow(
      'ambiguous',
    );
  });
});

describe('controlling the player', () => {
  it('pauses only the record the caller saw, and leaves one the user picked', async () => {
    const order = await preview();
    const { playlistId } = await bridge.playPreview({ expectedTrackIds: order, index: 0 });
    const on = { playlistId, index: 1, trackId: order[0] };

    music.pick(3);
    await expect(bridge.controlPlayer({ action: 'pause', on })).rejects.toThrow('moved off');
    expect(music.snapshot().player.state).toBe('playing');

    const here = { playlistId, index: 3, trackId: order[2] };

    expect(await bridge.controlPlayer({ action: 'pause', on: here })).toMatchObject({
      state: 'paused',
    });
  });

  it('will not resume a preview that was reordered while paused', async () => {
    const order = await preview();
    const { playlistId } = await bridge.playPreview({ expectedTrackIds: order, index: 0 });
    const on = { playlistId, index: 1, trackId: order[0] };

    await bridge.controlPlayer({ action: 'pause', on });
    await bridge.reorderPlaylistTracks({
      playlistId,
      order: [0, 2, 1, 3],
      expectedTrackIds: order,
    });

    await expect(
      bridge.controlPlayer({ action: 'resume', on, expectedTrackIds: order }),
    ).rejects.toThrow('order no longer matches');
  });

  it('follows a slot whose ID iCloud rotated, but not a copy sharing its name', async () => {
    const order = await preview();
    const { playlistId } = await bridge.playPreview({ expectedTrackIds: order, index: 0 });
    const rotated = music.rekey('Selecta Preview');
    const on = { playlistId: rotated, index: 1, trackId: order[0], slot: 'Selecta Preview' };

    expect(playlistId).not.toBe(rotated);
    expect(await bridge.controlPlayer({ action: 'seek', position: 30, on })).toMatchObject({
      position: expect.closeTo(30, 0),
    });

    music.addPlaylist('Selecta Preview', order);
    await expect(bridge.controlPlayer({ action: 'pause', on })).rejects.toThrow('ambiguous');
  });
});

it('reads the whole library through the real snapshot script', async () => {
  const snapshot = await bridge.readLibrary();

  expect(snapshot.tracks).toHaveLength(6);
  expect(snapshot.tracks[0]).toMatchObject({ persistentId: ids[0], title: tracks[0].name });
});

it('trims the double an iCloud add can leave', async () => {
  const order = await preview(ids.slice(0, 2));
  const playlistId = music.snapshot().playlists[0].id;

  music.doubleAdds = true;

  const result = await bridge.addPlaylistTracks({ playlistId, trackIds: [ids[4]] });

  expect(result.trackPersistentIds).toEqual([...order, ids[4]]);
});
