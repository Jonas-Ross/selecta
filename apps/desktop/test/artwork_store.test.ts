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

it('reports a failed lookup and asks again only when told to', async () => {
  const get = vi
    .fn()
    .mockRejectedValueOnce(new Error('Music.app is not running'))
    .mockResolvedValue({ [id(1)]: `${id(1)}.jpg`, [id(2)]: null });
  const store = createArtworkStore(get);
  const failed = vi.fn();

  store.onFailure(failed);
  const leave = store.subscribe(id(1), () => {});

  store.subscribe(id(2), () => {});
  await tick();
  expect(failed).toHaveBeenCalledWith('Music.app is not running');
  expect(store.url(id(1))).toBeUndefined();

  // Remounting doesn't ask again; a retry asks only for what is still on screen.
  leave();
  store.subscribe(id(2), () => {});
  await tick();
  expect(get).toHaveBeenCalledOnce();
  store.retry();
  await tick();
  expect(get).toHaveBeenLastCalledWith({ track_ids: [id(2)] });
  expect(store.url(id(2))).toBeUndefined();

  store.subscribe(id(1), () => {});
  await tick();
  expect(get).toHaveBeenLastCalledWith({ track_ids: [id(1)] });
  expect(store.url(id(1))).toContain(id(1));
});

it('reports a track that failed without holding back the rest of its call', async () => {
  const get = vi
    .fn()
    .mockResolvedValue({ [id(1)]: { error: 'timed out' }, [id(2)]: `${id(2)}.jpg` });
  const store = createArtworkStore(get);
  const failed = vi.fn();

  store.onFailure(failed);
  store.subscribe(id(1), () => {});
  store.subscribe(id(2), () => {});
  await tick();
  expect(failed).toHaveBeenCalledExactlyOnceWith('timed out');
  expect(store.url(id(1))).toBeUndefined();
  expect(store.url(id(2))).toContain(id(2));
});

it('asks once more for art that would not show, then reports it', async () => {
  const get = vi.fn().mockResolvedValue({ [id(1)]: `${id(1)}.jpg` });
  const store = createArtworkStore(get);
  const failed = vi.fn();

  store.onFailure(failed);
  store.subscribe(id(1), () => {});
  await tick();
  store.broken(id(1));
  store.broken(id(1));
  await tick();
  expect(get).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenLastCalledWith({ track_ids: [id(1)], refresh: [id(1)] });
  expect(store.url(id(1))).toContain(id(1));
  store.broken(id(1));
  expect(store.url(id(1))).toBeUndefined();
  expect(failed).toHaveBeenCalledOnce();
  // Trying again still has the host drop the file that wouldn't show.
  store.retry();
  await tick();
  expect(get).toHaveBeenLastCalledWith({ track_ids: [id(1)], refresh: [id(1)] });
});

it('tells a listener that arrives later about a failure still standing', async () => {
  const get = vi.fn().mockRejectedValue(new Error('Music.app is not running'));
  const store = createArtworkStore(get);

  store.subscribe(id(1), () => {});
  await tick();

  const late = vi.fn();

  store.onFailure(late);
  expect(late).toHaveBeenCalledExactlyOnceWith('Music.app is not running');
  store.retry();
  store.onFailure(late);
  expect(late).toHaveBeenCalledOnce();
});
