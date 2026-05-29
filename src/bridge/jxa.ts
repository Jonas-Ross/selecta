// osascript invocation + JSON parsing. The single place that shells out to
// `osascript -l JavaScript`. See docs/contracts.md §4.
//
// Each call is a fresh process — no shared runtime state, no long-lived bridge.

import { execFile } from 'node:child_process';
import { BridgeError, type ErrorCode } from './types.js';

// macOS Apple-event privilege denial. errAEPrivilegeError is -1743.
const PERMISSION_SIGNATURE = /errAEPrivilegeError|-1743|not authorized/i;
// App isn't running / can't be launched. -600 is procNotFound.
const NOT_RUNNING_SIGNATURE = /-600|isn['’]?t running|not running|can['’]?t be found/i;

function mapJxaError(stderr: string): ErrorCode {
  if (PERMISSION_SIGNATURE.test(stderr)) return 'automation_permission_denied';
  if (NOT_RUNNING_SIGNATURE.test(stderr)) return 'music_app_not_running';
  return 'jxa_error';
}

// The bridge knows only the error code; the model-facing hint is resolved by
// consumers via defaultHints (docs/contracts.md §2), so no hint is attached here.
const jxaError = (code: ErrorCode, message: string): BridgeError =>
  new BridgeError(code, message);

/**
 * Run a JXA script via osascript and parse its stdout as JSON.
 * Throws BridgeError with the appropriate ErrorCode on every failure mode:
 * non-zero exit (mapped from stderr) or unparseable stdout.
 */
export function runJxa(script: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', script],
      (error, stdout, stderr) => {
        if (error) {
          reject(
            jxaError(mapJxaError(stderr), `osascript failed: ${stderr.trim() || error.message}`),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(
            jxaError('jxa_error', `osascript returned unparseable stdout: ${stdout.slice(0, 200)}`),
          );
        }
      },
    );
  });
}
