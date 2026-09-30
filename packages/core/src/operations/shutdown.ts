// Process-owner policy: what to do with held operation locks when this process
// is ending. Only something that owns the process (the CLI) may install this;
// the lock layer itself stays out of process-global state.

import { releaseHeldEnrichLocks } from './lock.js';

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Drop held enrich locks if this run is signalled away, then let the signal
 * land as it would have. Returns a function that uninstalls it.
 */
export function releaseLocksOnShutdown(): () => void {
  const handlers = SIGNALS.map((signal) => {
    const handler = (): void => {
      uninstall();
      releaseHeldEnrichLocks();
      // Re-raise rather than exit: the caller asked for this signal, and a
      // listener is the only reason it did not already terminate here.
      process.kill(process.pid, signal);
    };

    process.on(signal, handler);

    return () => process.off(signal, handler);
  });

  function uninstall(): void {
    for (const off of handlers) off();
  }

  return uninstall;
}
