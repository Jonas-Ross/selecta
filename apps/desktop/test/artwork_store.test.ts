import { expect, it, vi } from 'vitest';
import { createArtworkStore } from '../src/renderer/artwork.js';

// The module-level store reads window.selecta, which a node test has none of.
vi.mock('../src/renderer/api.js', () => ({ selecta: { call: vi.fn() } }));

const id = (n: number) => n.toString(16).toUpperCase().padStart(16, '0');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

it('asks once for everything subscribed in the same tick, in chunks of 200', async () => {
  const get = vi.fn(async ({ track_ids }: { track_ids: string[] }) =>
    Object.fromEntries(track_ids.map((track) => [track, `${track}.jpg`])),
  );
  const store = createArtworkStore(get);
  const ids = Array.from({ length: 250 }, (_, i) => id(i + 1));

  for (const track of [...ids, ids[0]!]) store.subscribe(track, () => {});

  expect(get).not.toHaveBeenCalled();
  await tick();
  expect(get.mock.calls.map(([args]) => args.track_ids.length)).toEqual([200, 50]);
  expect(store.url(ids[0]!)).toBe(`selecta-art://thumb/${ids[0]}.jpg`);

  store.subscribe(ids[0]!, () => {});
  await tick();
  expect(get).toHaveBeenCalledTimes(2);
});

it('notifies subscribers when their answer lands, and keeps no art as an answer', async () => {
  let answer!: (files: Record<string, string | null>) => void;
  const get = vi.fn(() => new Promise<Record<string, string | null>>((r) => (answer = r)));
  const store = createArtworkStore(get);
  const [a, b] = [id(1), id(2)];
  const heard = vi.fn();
  const gone = vi.fn();

  store.subscribe(a, heard);
  store.subscribe(b, gone)();
  await tick();
  expect(store.url(a)).toBeUndefined();

  answer({ [a]: `${a}.jpg`, [b]: null });
  await tick();
  expect(heard).toHaveBeenCalledOnce();
  expect(gone).not.toHaveBeenCalled();
  expect(store.url(a)).toBe(`selecta-art://thumb/${a}.jpg`);
  expect(store.url(b)).toBeUndefined();

  store.subscribe(b, () => {});
  await tick();
  expect(get).toHaveBeenCalledOnce();
});

it('reports a failed lookup instead of settling it as no art, and asks again on the next mount', async () => {
  const get = vi.fn().mockRejectedValue(new Error('Music.app is not running'));
  const store = createArtworkStore(get);
  const failed = vi.fn();

  store.onFailure(failed);
  store.subscribe(id(1), () => {});
  await tick();
  expect(failed).toHaveBeenCalledWith('Music.app is not running');
  expect(store.url(id(1))).toBeUndefined();
  store.subscribe(id(1), () => {});
  await tick();
  expect(get).toHaveBeenCalledTimes(2);
});
