// osascript invocation + JSON parsing. The single place that shells out to
// `osascript -l JavaScript`.
//
// Each call is a fresh process; worker.ts keeps warm ones for the hot paths.

import { execFile } from 'node:child_process';
import {
  interruptedError,
  JXA_TIMEOUT_MS,
  jxaFailure,
  MAX_STDOUT_BYTES,
  parseJxaStdout,
} from './osascript.js';
import { runWarmJxa } from './worker.js';

/**
 * Run a JXA script via osascript and parse its stdout as JSON.
 * Throws BridgeError with the appropriate ErrorCode on every failure mode:
 * non-zero exit (mapped from stderr) or unparseable stdout.
 */
export function runJxa(script: string, { warm = false } = {}): Promise<unknown> {
  if (warm) return runWarmJxa(script);

  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', script],
      { maxBuffer: MAX_STDOUT_BYTES, timeout: JXA_TIMEOUT_MS, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error?.killed) {
          reject(interruptedError());

          return;
        }

        if (error) {
          reject(jxaFailure(stderr, error.message));

          return;
        }

        try {
          resolve(parseJxaStdout(stdout));
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}
