// Album art for the rail, read from Music.app once and kept as thumbnails in
// the user's cache folder. Music.app is asked one batch at a time, never twice
// for the same track in a session.
import { execFile } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  ARTWORK_BATCH_LIMIT,
  TRACK_PERSISTENT_ID,
  type ArtworkReadResult,
} from '@selecta/core/types/bridge.js';
import { ARTWORK_FILE } from '../shared/artwork.js';

export type ArtworkDeps = {
  dir: string;
  read: (trackIds: string[], dir: string) => Promise<ArtworkReadResult>;
  resize: (source: string, target: string) => Promise<void>;
  log?: (message: string) => void;
};

export type ArtworkCache = {
  get(trackIds: string[]): Promise<Record<string, string | null>>;
};

const run = promisify(execFile);

/** macOS sips: longest side 600px, re-encoded as JPEG. */
export async function sipsThumbnail(source: string, target: string): Promise<void> {
  await run('sips', [
    '-Z',
    '600',
    '-s',
    'format',
    'jpeg',
    '-s',
    'formatOptions',
    '80',
    source,
    '--out',
    target,
  ]);
}

export function createArtworkCache({ dir, read, resize, log }: ArtworkDeps): ArtworkCache {
  // Originals land beside, not in, the served folder, so main never sees a
  // half-converted file under a thumbnail's name.
  const incoming = join(dir, 'incoming');
  // Settled or in-flight answers for this session. No-art stays here, so it
  // is asked again only after a relaunch; a failed read is dropped.
  const answers = new Map<string, Promise<string | null>>();
  const settle = new Map<string, (file: string | null) => void>();
  const queue: string[] = [];
  let onDisk: Promise<Set<string>> | undefined;
  let pumping = false;

  function finish(id: string, file: string | null, remember: boolean) {
    settle.get(id)?.(file);
    settle.delete(id);

    if (!remember) answers.delete(id);
  }

  async function thumbnail(id: string, original: string | null): Promise<void> {
    if (original === null) return finish(id, null, true);

    const thumb = `${id}.jpg`;
    const source = join(incoming, original);

    let made = false;

    try {
      await resize(source, join(dir, thumb));
      made = true;
    } catch (error) {
      log?.(`selecta: cannot make an artwork thumbnail for ${id}: ${String(error)}`);
    }

    await rm(source, { force: true }).catch(() => {});
    finish(id, made ? thumb : null, made);
  }

  async function readBatch(batch: string[]): Promise<void> {
    let written: ArtworkReadResult;

    try {
      await mkdir(incoming, { recursive: true });
      written = await read(batch, incoming);
    } catch (error) {
      log?.(`selecta: cannot read artwork from Music.app: ${String(error)}`);

      for (const id of batch) finish(id, null, false);

      return;
    }

    await Promise.all(batch.map((id) => thumbnail(id, written[id] ?? null)));
  }

  async function pump(): Promise<void> {
    if (pumping) return;

    pumping = true;
    // Lets callers in the same tick join the first batch.
    await new Promise((resolve) => setImmediate(resolve));

    try {
      while (queue.length > 0) await readBatch(queue.splice(0, ARTWORK_BATCH_LIMIT));
    } finally {
      pumping = false;
    }
  }

  function lookup(id: string, cached: Set<string>): Promise<string | null> {
    const known = answers.get(id);

    if (known) return known;

    if (cached.has(`${id}.jpg`)) return Promise.resolve(`${id}.jpg`);

    const answer = new Promise<string | null>((resolve) => settle.set(id, resolve));

    answers.set(id, answer);
    queue.push(id);

    return answer;
  }

  return {
    async get(trackIds) {
      // Originals a crashed session left behind are cleared before the first read.
      onDisk ??= rm(incoming, { recursive: true, force: true })
        .catch(() => {})
        .then(() => readdir(dir))
        .then(
          (files) => new Set(files.filter((file) => ARTWORK_FILE.test(file))),
          () => new Set<string>(),
        );

      const cached = await onDisk;
      const pending = trackIds.map((id) =>
        TRACK_PERSISTENT_ID.test(id) ? lookup(id, cached) : Promise.resolve(null),
      );

      if (queue.length > 0) void pump();

      const files = await Promise.all(pending);

      return Object.fromEntries(trackIds.map((id, i) => [id, files[i]!]));
    },
  };
}
