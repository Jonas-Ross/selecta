// Album art for the rail, read from Music.app once and kept as thumbnails in
// the user's cache folder. Music.app is asked one batch at a time, never twice
// for the same track in a session.
import { execFile } from 'node:child_process';
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  ARTWORK_BATCH_LIMIT,
  TRACK_PERSISTENT_ID,
  type ArtworkReadResult,
} from '@selecta/core/types/bridge.js';
import { ARTWORK_FILE } from '../shared/artwork.js';
import type { ArtworkAnswer } from '../shared/protocol.js';

export type ArtworkDeps = {
  dir: string;
  read: (trackIds: string[], dir: string) => Promise<ArtworkReadResult>;
  resize: (source: string, target: string) => Promise<void>;
  log?: (message: string) => void;
};

export type ArtworkCache = {
  /** Never rejects: a track whose read failed answers with the reason, the rest still land. */
  get(trackIds: string[]): Promise<Record<string, ArtworkAnswer>>;
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
  // is asked again only after a relaunch; a failure is dropped and rejected.
  const answers = new Map<string, Promise<string | null>>();
  const settle = new Map<
    string,
    { resolve: (file: string | null) => void; reject: (error: unknown) => void }
  >();
  const queue: string[] = [];
  let onDisk: Promise<Set<string>> | undefined;
  let pumping = false;

  function finish(id: string, file: string | null) {
    settle.get(id)?.resolve(file);
    settle.delete(id);
  }

  // A failed read or resize is not the same as a track with no art, so the caller hears it.
  function fail(id: string, error: unknown) {
    settle.get(id)?.reject(error);
    settle.delete(id);
    answers.delete(id);
  }

  async function thumbnail(id: string, original: ArtworkReadResult[string]): Promise<void> {
    if (original === null) return finish(id, null);

    if (typeof original !== 'string')
      return fail(
        id,
        new Error(`Music.app couldn't read this track's artwork: ${original.error}.`),
      );

    const thumb = `${id}.jpg`;
    const source = join(incoming, original);
    // Converted beside the original and moved in whole, so a failed sips never
    // leaves a partial file under a name the next launch trusts.
    const draft = join(incoming, `${id}.thumb.jpg`);

    const failed = await resize(source, draft)
      .then(() => rename(draft, join(dir, thumb)))
      .then(
        () => undefined,
        (error: unknown) => ({ error }),
      );

    // The leftovers go before anyone hears back, so no caller sees them linger.
    await Promise.all([source, draft].map((file) => rm(file, { force: true }).catch(() => {})));

    if (!failed) return finish(id, thumb);

    log?.(`selecta: cannot make an artwork thumbnail for ${id}: ${String(failed.error)}`);
    fail(id, failed.error);
  }

  async function readBatch(batch: string[]): Promise<void> {
    let written: ArtworkReadResult;

    try {
      await mkdir(incoming, { recursive: true });
      written = await read(batch, incoming);
    } catch (error) {
      log?.(`selecta: cannot read artwork from Music.app: ${String(error)}`);

      for (const id of batch) fail(id, error);

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

  function ask(id: string): Promise<string | null> {
    const answer = new Promise<string | null>((resolve, reject) =>
      settle.set(id, { resolve, reject }),
    );

    answers.set(id, answer);
    queue.push(id);
    void pump();

    return answer;
  }

  async function lookup(id: string, cached: Set<string>): Promise<string | null> {
    const file = await (answers.get(id) ??
      (cached.has(`${id}.jpg`) ? Promise.resolve(`${id}.jpg`) : ask(id)));

    if (
      file === null ||
      (await access(join(dir, file)).then(
        () => true,
        () => false,
      ))
    )
      return file;

    // The thumbnail was deleted or evicted since; read it from Music.app again.
    answers.delete(id);
    cached.delete(file);

    return ask(id);
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
      const answered = await Promise.allSettled(
        trackIds.map((id) => (TRACK_PERSISTENT_ID.test(id) ? lookup(id, cached) : null)),
      );

      return Object.fromEntries(
        trackIds.map((id, i) => {
          const result = answered[i]!;

          return [
            id,
            result.status === 'fulfilled'
              ? result.value
              : {
                  error:
                    result.reason instanceof Error ? result.reason.message : String(result.reason),
                },
          ];
        }),
      );
    },
  };
}
