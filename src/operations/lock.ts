import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { SelectaCache } from '../cache/index.js';
import { BridgeError } from '../types/errors.js';

const memoryLocks = new WeakMap<object, Set<string>>();

/** A settled action can survive this failure; the named lock still needs recovery. */
export class OperationCleanupError extends Error {
  constructor(
    readonly lockPath: string,
    cause: unknown,
  ) {
    super(`Could not remove operation lock ${lockPath}: ${String(cause)}`, { cause });
    this.name = 'OperationCleanupError';
  }

  get recoveryHint(): string {
    return `Stop all Selecta processes and inspect Music.app for pending writes before removing ${this.lockPath}. Never remove a live owner's lock.`;
  }
}

/** Keep the read/await/write cycle exclusive across CLI and MCP processes. */
export async function withOperation<T>(
  cache: SelectaCache,
  kind: 'music' | 'enrich',
  action: () => Promise<T>,
): Promise<T> {
  const busy = (location: string) =>
    new BridgeError(
      'operation_busy',
      `Another ${kind} operation holds ${location}`,
      `Another ${kind} operation is active. Wait for it to finish before trying again. If a process crashed, stop all Selecta processes, inspect Music.app for partial writes, then remove ${location}.`,
    );
  let release: () => void;

  if (cache.db.memory) {
    const held = memoryLocks.get(cache.db) ?? new Set<string>();

    memoryLocks.set(cache.db, held);

    if (held.has(kind)) throw busy('the in-memory lock');

    held.add(kind);

    release = () => {
      held.delete(kind);
    };
  } else {
    let location: string;

    try {
      location = `${realpathSync(cache.db.name)}.${kind}.lock`;
    } catch {
      throw new BridgeError('cache_unavailable', 'Cannot resolve cache path');
    }

    try {
      mkdirSync(location, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw busy(location);

      throw new BridgeError('cache_unavailable', 'Cannot acquire operation lock');
    }

    release = () => {
      try {
        rmSync(location, { recursive: true });
      } catch (error) {
        throw new OperationCleanupError(location, error);
      }
    };

    try {
      writeFileSync(`${location}/owner`, `pid=${process.pid}\n`, { mode: 0o600 });
    } catch (err) {
      release();
      throw err;
    }
  }

  try {
    return await action();
  } finally {
    release();
  }
}
