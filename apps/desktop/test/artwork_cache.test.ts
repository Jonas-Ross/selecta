import { copyFile, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createArtworkCache, type ArtworkDeps } from '../src/host/artwork.js';

const id = (n: number) => n.toString(16).toUpperCase().padStart(16, '0');
const [A, B, C] = [id(0xa), id(0xb), id(0xc)];

/** A Music.app stand-in: writes a PNG original for every ID except those without art. */
async function setup(options: { noArt?: string[]; fail?: (ids: string[]) => boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'selecta-art-'));
  let inFlight = 0;
  let maxInFlight = 0;
  const read = vi.fn<ArtworkDeps['read']>(async (ids, target) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;

    if (options.fail?.(ids)) throw new Error('osascript failed');

    const written: Record<string, string | null> = {};

    for (const track of ids) {
      if (options.noArt?.includes(track)) written[track] = null;
      else {
        written[track] = `${track}.png`;
        await writeFile(join(target, written[track]), 'png');
      }
    }

    return written;
  });
  const resize = vi.fn<ArtworkDeps['resize']>((source, target) => copyFile(source, target));
  const deps = { dir, read, resize };

  return { dir, read, resize, deps, maxInFlight: () => maxInFlight };
}

it('reads uncached art once, as a thumbnail, and clears the original', async () => {
  const { dir, read, resize, deps } = await setup();
  const cache = createArtworkCache(deps);

  expect(await cache.get([A])).toEqual({ [A]: `${A}.jpg` });
  expect(read).toHaveBeenCalledExactlyOnceWith([A], join(dir, 'incoming'));
  expect(resize).toHaveBeenCalledWith(join(dir, 'incoming', `${A}.png`), join(dir, `${A}.jpg`));
  expect(await readdir(join(dir, 'incoming'))).toEqual([]);
  expect(await cache.get([A, A])).toEqual({ [A]: `${A}.jpg` });
  expect(read).toHaveBeenCalledOnce();
});

it('answers thumbnails already on disk without asking Music.app', async () => {
  const { dir, read, deps } = await setup();

  await writeFile(join(dir, `${A}.jpg`), 'jpg');
  await mkdir(join(dir, 'incoming'));
  await writeFile(join(dir, 'incoming', `${B}.png`), 'stranded');
  expect(await createArtworkCache(deps).get([A])).toEqual({ [A]: `${A}.jpg` });
  expect(read).not.toHaveBeenCalled();
  expect(await readdir(dir)).toEqual([`${A}.jpg`]);
});

it('shares one batch between concurrent callers and never asks twice for an ID', async () => {
  const { read, deps } = await setup();
  const cache = createArtworkCache(deps);
  const [first, second] = await Promise.all([cache.get([A, B]), cache.get([B, C])]);

  expect(first).toEqual({ [A]: `${A}.jpg`, [B]: `${B}.jpg` });
  expect(second).toEqual({ [B]: `${B}.jpg`, [C]: `${C}.jpg` });
  expect(read).toHaveBeenCalledExactlyOnceWith([A, B, C], expect.any(String));
});

it('runs one read at a time, in batches of at most 40', async () => {
  const { read, deps, maxInFlight } = await setup();
  const cache = createArtworkCache(deps);
  const ids = Array.from({ length: 90 }, (_, i) => id(i + 1));
  const answers = await Promise.all([cache.get(ids.slice(0, 50)), cache.get(ids.slice(30))]);

  expect(read.mock.calls.map(([batch]) => batch.length)).toEqual([40, 40, 10]);
  expect(new Set(read.mock.calls.flatMap(([batch]) => batch)).size).toBe(90);
  expect(maxInFlight()).toBe(1);
  expect(Object.values({ ...answers[0], ...answers[1] }).every((file) => file !== null)).toBe(true);
});

it('remembers no art for the session only', async () => {
  const { read, deps } = await setup({ noArt: [B] });
  const cache = createArtworkCache(deps);

  expect(await cache.get([B])).toEqual({ [B]: null });
  expect(await cache.get([B])).toEqual({ [B]: null });
  expect(read).toHaveBeenCalledOnce();

  await createArtworkCache(deps).get([B]);
  expect(read).toHaveBeenCalledTimes(2);
});

it('fails a failed batch for its own IDs only, and asks again later', async () => {
  const { read, deps } = await setup({ fail: (ids) => ids.includes(A) });
  const log = vi.fn();
  const cache = createArtworkCache({ ...deps, log });
  const first = expect(cache.get([A])).rejects.toThrow('osascript failed');

  // Queued while the first batch is in flight, so it rides the next one.
  await vi.waitFor(() => expect(read).toHaveBeenCalled());
  const second = cache.get([B]);

  await first;
  expect(await second).toEqual({ [B]: `${B}.jpg` });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('osascript failed'));

  await cache.get([A]).catch(() => {});
  expect(read.mock.calls.map(([batch]) => batch)).toEqual([[A], [B], [A]]);
});

it('drops an original whose thumbnail fails, without remembering it', async () => {
  const { dir, read, resize, deps } = await setup();
  const cache = createArtworkCache({ ...deps, log: () => {} });

  resize.mockRejectedValueOnce(new Error('sips failed'));
  expect(await cache.get([A])).toEqual({ [A]: null });
  expect(await readdir(join(dir, 'incoming'))).toEqual([]);
  expect(await cache.get([A])).toEqual({ [A]: `${A}.jpg` });
  expect(read).toHaveBeenCalledTimes(2);
});

it('answers anything but a persistent ID with null and never passes it on', async () => {
  const { read, deps } = await setup();
  const odd = ['T-TEARDROP', '0123456789abcdef', `../${A}`];

  expect(await createArtworkCache(deps).get(odd)).toEqual(
    Object.fromEntries(odd.map((track) => [track, null])),
  );
  expect(read).not.toHaveBeenCalled();
});
