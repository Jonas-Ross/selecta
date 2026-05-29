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

const HINTS: Partial<Record<ErrorCode, string>> = {
  automation_permission_denied:
    'macOS has not granted Music.app automation access. Enable it in System Settings → Privacy & Security → Automation.',
  music_app_not_running: 'Music.app is not running. Open it before retrying.',
  jxa_error: 'osascript exited non-zero or returned an unparseable response.',
};

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
          const code = mapJxaError(stderr);
          reject(
            new BridgeError(
              code,
              `osascript failed: ${stderr.trim() || error.message}`,
              HINTS[code],
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(
            new BridgeError(
              'jxa_error',
              `osascript returned unparseable stdout: ${stdout.slice(0, 200)}`,
              HINTS.jxa_error,
            ),
          );
        }
      },
    );
  });
}
