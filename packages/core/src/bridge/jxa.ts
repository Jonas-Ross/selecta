// osascript invocation + JSON parsing. The single place that shells out to
// `osascript -l JavaScript`.
//
// Each call is a fresh process unless it asks for the shared one: starting osascript costs
// about 100 ms, and a running one answers a read in about 8 ms (docs/music-app.md, JXA).

import {
  execFile,
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { BridgeError, type ErrorCode } from '../types/errors.js';

// macOS Apple-event privilege denial. errAEPrivilegeError is -1743.
const PERMISSION_SIGNATURE = /errAEPrivilegeError|-1743|not authorized/i;
// App isn't running / can't be launched. -600 is procNotFound.
const NOT_RUNNING_SIGNATURE = /-600|isn['’]?t running|not running|can['’]?t be found/i;

// Whole-process stderr identifies the error, not which Apple event failed.
// These codes never prove that creation stopped before Music.make.
function mapJxaError(stderr: string): ErrorCode {
  if (PERMISSION_SIGNATURE.test(stderr)) return 'automation_permission_denied';

  if (NOT_RUNNING_SIGNATURE.test(stderr)) return 'music_app_not_running';

  return 'jxa_error';
}

// The bridge knows only the error code; the model-facing hint is resolved by
// consumers via defaultHints, so no hint is attached here.
const jxaError = (code: ErrorCode, message: string): BridgeError => new BridgeError(code, message);

const interrupted = () =>
  new BridgeError(
    'jxa_error',
    'osascript exceeded its deadline or output limit',
    'The Music.app operation was interrupted; its outcome is unknown and writes may be partial. Inspect Music.app and run refresh_library before deciding what to do. Do not repeat the write blindly.',
  );

// A full-library snapshot is megabytes of JSON on stdout; execFile's default
// maxBuffer (1 MiB) would kill the read mid-stream.
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const DEADLINE_MS = 180_000;

let shared: ReturnType<typeof createJxaWorker> | undefined;

/**
 * Run a JXA script via osascript and parse its stdout as JSON.
 * Throws BridgeError with the appropriate ErrorCode on every failure mode:
 * non-zero exit (mapped from stderr) or unparseable stdout. `shared` runs it in the
 * long-lived worker, behind any other shared call.
 */
export function runJxa(script: string, { shared: share = false } = {}): Promise<unknown> {
  if (share) return (shared ??= createJxaWorker()).run(script);

  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', script],
      { maxBuffer: MAX_STDOUT_BYTES, timeout: DEADLINE_MS, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error?.killed) {
          reject(interrupted());

          return;
        }

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

// Recognised by the desktop harness's stand-in osascript, which then serves calls the same way.
export const WORKER_MARKER = '// selecta jxa worker';

// Reads one JSON-string script per line and writes one {out} or {err} line per answer. Each
// script runs in a fresh function scope, so its `const args` never meets the last one's.
// Not named run(): osascript would invoke a run handler after the loop (wrap.ts).
export const WORKER_SCRIPT = `${WORKER_MARKER}
ObjC.import('Foundation');
const selectaIn = $.NSFileHandle.fileHandleWithStandardInput;
const selectaOut = $.NSFileHandle.fileHandleWithStandardOutput;
function selectaSend(answer) {
  selectaOut.writeData($(JSON.stringify(answer) + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
}
function selectaOne(src) { return eval(src); }
let selectaPending = '';
for (;;) {
  const data = selectaIn.availableData;
  if (data.length === 0) break;
  selectaPending += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  let at;
  while ((at = selectaPending.indexOf('\\n')) >= 0) {
    const line = selectaPending.slice(0, at);
    selectaPending = selectaPending.slice(at + 1);
    try {
      selectaSend({ out: String(selectaOne(JSON.parse(line))) });
    } catch (e) {
      selectaSend({ err: String(e) + (e && e.errorNumber !== undefined ? ' (' + e.errorNumber + ')' : '') });
    }
  }
}
`;

// ASCII only, so a script split across stdin reads never splits a character.
const encode = (script: string) =>
  `${JSON.stringify(script).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;

type Call = { script: string; resolve: (value: unknown) => void; reject: (error: unknown) => void };

export function createJxaWorker({
  spawn = spawnChild,
  deadlineMs = DEADLINE_MS,
}: { spawn?: typeof spawnChild; deadlineMs?: number } = {}) {
  const queue: Call[] = [];
  let child: ChildProcessWithoutNullStreams | undefined;
  let current: (Call & { timer: ReturnType<typeof setTimeout> }) | undefined;
  let buffer = '';

  // Held only while a call is out, so an idle worker never keeps a CLI from exiting.
  function hold(on: boolean) {
    for (const handle of [child, child?.stdin, child?.stdout, child?.stderr] as {
      ref?: () => void;
      unref?: () => void;
    }[])
      (on ? handle?.ref : handle?.unref)?.call(handle);
  }

  function finish(settle: (call: Call) => void) {
    const call = current;

    if (!call) return;

    clearTimeout(call.timer);
    current = undefined;
    settle(call);
    pump();
  }

  function answer(line: string) {
    let parsed: { out?: unknown; err?: unknown };

    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      return finish((call) =>
        call.reject(jxaError('jxa_error', `osascript worker wrote ${line.slice(0, 200)}`)),
      );
    }

    if (typeof parsed.err === 'string') {
      const err = parsed.err;

      return finish((call) =>
        call.reject(jxaError(mapJxaError(err), `osascript failed: ${err.trim()}`)),
      );
    }

    const out = String(parsed.out);

    finish((call) => {
      try {
        call.resolve(JSON.parse(out));
      } catch {
        call.reject(
          jxaError('jxa_error', `osascript returned unparseable stdout: ${out.slice(0, 200)}`),
        );
      }
    });
  }

  function start(): ChildProcessWithoutNullStreams {
    const next = spawn('osascript', ['-l', 'JavaScript', '-e', WORKER_SCRIPT]);

    buffer = '';
    next.stdout.setEncoding('utf8');
    next.stdout.on('data', (chunk: string) => {
      buffer += chunk;

      if (buffer.length > MAX_STDOUT_BYTES) return void next.kill('SIGKILL');

      let at;

      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);

        buffer = buffer.slice(at + 1);
        answer(line);
      }
    });
    // Script errors come back as {err} lines; anything here is osascript's own noise.
    next.stderr.resume();
    // A write to a worker that just died surfaces as its exit, below.
    next.stdin.on('error', () => {});

    // The call in flight may have done anything before the worker died, so its outcome is unknown.
    const died = () => {
      if (child !== next) return;

      child = undefined;
      finish((call) => call.reject(interrupted()));
    };

    next.on('exit', died);
    next.on('error', (error) => {
      if (child !== next) return;

      child = undefined;
      finish((call) => call.reject(jxaError(mapJxaError(error.message), error.message)));
    });

    return next;
  }

  function pump() {
    if (current || !queue.length) {
      if (!current) hold(false);

      return;
    }

    child ??= start();
    hold(true);

    const call = queue.shift()!;
    const running = child;

    current = { ...call, timer: setTimeout(() => running.kill('SIGKILL'), deadlineMs) };
    running.stdin.write(encode(call.script));
  }

  return {
    run(script: string): Promise<unknown> {
      return new Promise((resolve, reject) => {
        queue.push({ script, resolve, reject });
        pump();
      });
    },
  };
}
