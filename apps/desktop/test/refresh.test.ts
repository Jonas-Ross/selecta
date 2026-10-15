import { expect, it, vi } from 'vitest';
import type { LibrarySnapshot } from '@selecta/core/types/bridge.js';
import fixture from '../../../packages/core/test/fixtures/library.json' with { type: 'json' };
import { makeToolDeps } from '../../../packages/core/test/helpers.js';
import { createLibrary } from '../src/host/refresh.js';
import type { LibraryView, Measured } from '../src/shared/protocol.js';

const library = fixture as LibrarySnapshot;
const added: LibrarySnapshot = {
  ...library,
  tracks: [...library.tracks, { ...library.tracks[0], persistentId: 'T-NEW', title: 'New One' }],
};

function setup(measure: (id: string) => Promise<Measured>, read = async () => added) {
  const deps = makeToolDeps({ readLibrary: vi.fn(read) });
  const views: LibraryView[] = [];
  const settled = new Promise<LibraryView>((resolve) => {
    const lib = createLibrary({
      cache: deps.cache,
      bridge: deps.bridge,
      measure,
      onChange: (view) => {
        views.push(view);

        if (!view.reading && !view.measuring) resolve(view);
      },
    });

    queueMicrotask(() => views.push(lib.refresh(), lib.refresh()));
  });

  return { deps, views, settled };
}

it('reads the library, then measures the tracks it brought in before older unheard ones', async () => {
  const asked: string[] = [];
  const { deps, views, settled } = setup(async (id) => {
    asked.push(id);

    return id === 'T-BARE' ? { tempo: 'unsure', key: 'unsure' } : {};
  });
  const done = await settled;

  expect(deps.bridge.readLibrary).toHaveBeenCalledTimes(1);
  expect(asked[0]).toBe('T-NEW');
  expect(asked).toHaveLength(7);
  expect(views[0]).toMatchObject({ reading: true });
  expect(views).toContainEqual(expect.objectContaining({ measuring: { done: 0, of: 7 } }));
  expect(done).toMatchObject({ measured: 6, left: 0 });
  expect(done.read_at).toEqual(expect.any(Number));
  expect(deps.cache().getTrack('T-NEW')).toMatchObject({ title: 'New One' });
});

it('stops measuring when a whole run fails, and says the read still landed', async () => {
  const measure = vi.fn(async (): Promise<Measured> => ({
    tempo: 'failed',
    key: 'failed',
    error: 'metrognome was not found',
  }));
  const done = await setup(measure).settled;

  expect(done).toMatchObject({
    failed: 'measure',
    error: 'metrognome was not found',
    measured: 0,
  });
  expect(done.read_at).toEqual(expect.any(Number));
});

it('reports a failed read and measures nothing', async () => {
  const measure = vi.fn(async (): Promise<Measured> => ({}));
  const done = await setup(measure, async () => {
    throw new Error('Music.app is not running');
  }).settled;

  expect(done).toMatchObject({ failed: 'read', error: 'Music.app is not running' });
  expect(measure).not.toHaveBeenCalled();
});
