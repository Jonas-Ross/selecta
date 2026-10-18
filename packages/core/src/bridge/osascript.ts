// What every osascript run shares, one-shot or warm: how its errors map, its
// deadline and its output limit.

import { BridgeError, type ErrorCode } from '../types/errors.js';

// macOS Apple-event privilege denial. errAEPrivilegeError is -1743.
const PERMISSION_SIGNATURE = /errAEPrivilegeError|-1743|not authorized/i;
// App isn't running / can't be launched. -600 is procNotFound.
const NOT_RUNNING_SIGNATURE = /-600|isn['’]?t running|not running|can['’]?t be found/i;

// Whole-process stderr identifies the error, not which Apple event failed.
// These codes never prove that creation stopped before Music.make.
export function mapJxaError(stderr: string): ErrorCode {
  if (PERMISSION_SIGNATURE.test(stderr)) return 'automation_permission_denied';

  if (NOT_RUNNING_SIGNATURE.test(stderr)) return 'music_app_not_running';

  return 'jxa_error';
}

// The bridge knows only the error code; the model-facing hint is resolved by
// consumers via defaultHints, so no hint is attached here.
export const jxaError = (code: ErrorCode, message: string): BridgeError =>
  new BridgeError(code, message);

// A full-library snapshot is megabytes of JSON on stdout; execFile's default
// maxBuffer (1 MiB) would kill the read mid-stream.
export const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
export const JXA_TIMEOUT_MS = 180_000;

export const jxaFailure = (stderr: string, fallback = '') =>
  jxaError(mapJxaError(stderr), `osascript failed: ${stderr.trim() || fallback}`);

export function parseJxaStdout(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw jxaError('jxa_error', `osascript returned unparseable stdout: ${stdout.slice(0, 200)}`);
  }
}

export const interruptedError = () =>
  new BridgeError(
    'jxa_error',
    'osascript exceeded its deadline or output limit',
    'The Music.app operation was interrupted; its outcome is unknown and writes may be partial. Inspect Music.app and run refresh_library before deciding what to do. Do not repeat the write blindly.',
  );
