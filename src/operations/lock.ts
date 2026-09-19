import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { SelectaCache } from '../cache/index.js';
import { BridgeError } from '../types/errors.js';

const memoryLocks = new WeakMap<object, Set<string>>();

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

type Signal = (typeof SIGNALS)[number];

const signalHandlers: Record<Signal, () => void> = {
  SIGINT: () => onSignal('SIGINT'),
  SIGTERM: () => onSignal('SIGTERM'),
};

// Enrich locks held right now, dropped together when the process ends.
const pendingReleases = new Set<() => void>();
let attached = false;

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

  // An hours-long enrich is normally ended by Ctrl-C, and it writes nowhere but
  // this cache. A music lock survives a signal on purpose: a half-finished
  // Music.app write is the thing it warns about.
  const disarm = kind === 'enrich' && !cache.db.memory ? releaseOnShutdown(release) : null;

  try {
    return await action();
  } finally {
    disarm?.();
    release();
  }
}

/**
 * Register a lock to drop when the process is ending.
 *
 * One set of process listeners serves every run, so concurrent runs cannot
 * mistake each other's handlers for an embedding host's.
 */
function releaseOnShutdown(release: () => void): () => void {
  pendingReleases.add(release);
  attach();

  return () => {
    pendingReleases.delete(release);

    if (pendingReleases.size === 0) detach();
  };
}

function releasePending(): void {
  for (const release of pendingReleases) {
    try {
      release();
    } catch {
      // Nothing can be reported from a process on its way out, and a lock that
      // outlives it is still recoverable by hand.
    }
  }

  pendingReleases.clear();
}

function onSignal(signal: Signal): void {
  // A host's own listener took this same delivery, so what happens next is its
  // decision: the run may continue and keep needing its lock, and if the host
  // ends the process instead, `exit` still drops it.
  if (process.listeners(signal).some((listener) => listener !== signalHandlers[signal])) return;

  detach();
  releasePending();
  // Nothing else was listening, so the default terminate this listener
  // suppressed is what should have happened.
  process.kill(process.pid, signal);
}

function attach(): void {
  if (attached) return;

  attached = true;

  for (const signal of SIGNALS) process.on(signal, signalHandlers[signal]);

  process.on('exit', releasePending);
}

function detach(): void {
  if (!attached) return;

  attached = false;

  for (const signal of SIGNALS) process.off(signal, signalHandlers[signal]);

  process.off('exit', releasePending);
}
