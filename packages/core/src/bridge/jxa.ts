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
import { createInterface } from 'node:readline';
import { BridgeError, preWriteError, type ErrorCode } from '../types/errors.js';

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

let sharedWorker: ReturnType<typeof createJxaWorker> | undefined;

/**
 * Run a JXA script via osascript and parse its stdout as JSON.
 * Throws BridgeError with the appropriate ErrorCode on every failure mode:
 * non-zero exit (mapped from stderr) or unparseable stdout. `shared` runs it in the
 * long-lived worker, behind any other shared call.
 */
export function runJxa(script: string, { shared = false } = {}): Promise<unknown> {
  if (shared) return (sharedWorker ??= createJxaWorker()).run(script);

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

// A worker answers this many calls, then a fresh one takes over, so nothing it holds grows forever.
const RECYCLE_AFTER = 1000;

// ASCII only, so a script split across stdin reads never splits a character.
const encode = (script: string) =>
  `${JSON.stringify(script).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;

type Call = {
  script: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  wait: ReturnType<typeof setTimeout>;
};
type Worker = { child: ChildProcessWithoutNullStreams; calls: number; stderr: string };

export function createJxaWorker({
  spawn = spawnChild,
  deadlineMs = DEADLINE_MS,
}: { spawn?: typeof spawnChild; deadlineMs?: number } = {}) {
  const queue: Call[] = [];
  // The worker new calls go to; a retired or killed one is dropped here and ignored after.
  let active: Worker | undefined;
  let current: { call: Call; worker: Worker; timer: ReturnType<typeof setTimeout> } | undefined;

  // Held only while a call is out, so an idle worker never keeps a CLI from exiting.
  function hold(worker: Worker | undefined, on: boolean) {
    const { child } = worker ?? {};

    for (const handle of [child, child?.stdin, child?.stdout, child?.stderr] as {
      ref?: () => void;
      unref?: () => void;
    }[])
      (on ? handle?.ref : handle?.unref)?.call(handle);
  }

  function retire(worker: Worker) {
    if (active === worker) active = undefined;

    hold(worker, false);
    worker.child.stdin.end();
  }

  function settle(worker: Worker, outcome: (call: Call) => void) {
    if (current?.worker !== worker) return;

    const { call, timer } = current;

    clearTimeout(timer);
    current = undefined;
    outcome(call);
    pump();
  }

  function answer(worker: Worker, line: string) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }

    const { out, err } = (parsed ?? {}) as { out?: unknown; err?: unknown };

    if (typeof err === 'string') {
      const code = mapJxaError(err);

      // A denial can stick to the process that asked, so the next call asks from a fresh one.
      if (code === 'automation_permission_denied') retire(worker);

      return settle(worker, (call) =>
        call.reject(jxaError(code, `osascript failed: ${err.trim()}`)),
      );
    }

    if (typeof out !== 'string')
      return settle(worker, (call) =>
        call.reject(jxaError('jxa_error', `osascript worker wrote ${line.slice(0, 200)}`)),
      );

    if (++worker.calls >= RECYCLE_AFTER) retire(worker);

    settle(worker, (call) => {
      try {
        call.resolve(JSON.parse(out));
      } catch {
        call.reject(
          jxaError('jxa_error', `osascript returned unparseable stdout: ${out.slice(0, 200)}`),
        );
      }
    });
  }

  function start(): Worker {
    const child = spawn('osascript', ['-l', 'JavaScript', '-e', WORKER_SCRIPT]);
    const worker: Worker = { child, calls: 0, stderr: '' };

    // Fails the call in flight; whatever ran before it died is unknown, as after a deadline.
    const died = (error?: Error) => {
      if (active === worker) active = undefined;

      const said = worker.stderr.trim() || error?.message;

      settle(worker, (call) =>
        call.reject(
          said ? jxaError(mapJxaError(said), `osascript worker failed: ${said}`) : interrupted(),
        ),
      );
    };

    child.on('error', died);
    // On close, not exit, so a line still in the pipe is read before the worker is called dead.
    child.on('close', () => died());
    child.stdin.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      worker.stderr = (worker.stderr + chunk).slice(-2000);
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.length > MAX_STDOUT_BYTES) return void child.kill('SIGKILL');

      answer(worker, line);
    });

    return worker;
  }

  function pump() {
    if (current) return;

    const call = queue.shift();

    if (!call) return hold(active, false);

    clearTimeout(call.wait);

    let worker: Worker;

    try {
      worker = active ??= start();
    } catch (error) {
      call.reject(jxaError('jxa_error', `osascript could not start: ${String(error)}`));

      return pump();
    }

    hold(worker, true);
    current = {
      call,
      worker,
      // Settled here rather than on the kill, so the next call never goes to the dying worker.
      timer: setTimeout(() => {
        retire(worker);
        worker.child.kill('SIGKILL');
        settle(worker, (late) => late.reject(interrupted()));
      }, deadlineMs),
    };
    worker.child.stdin.write(encode(call.script));
  }

  return {
    run(script: string): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const call: Call = {
          script,
          resolve,
          reject,
          // A call that never reached Music within the deadline is refused, so none waits unbounded.
          wait: setTimeout(() => {
            const at = queue.indexOf(call);

            if (at < 0) return;

            queue.splice(at, 1);
            reject(
              preWriteError(
                'jxa_error',
                'Music.app was still busy with an earlier call',
                'Nothing was sent to Music.app. Try again once it answers.',
              ),
            );
          }, deadlineMs),
        };

        queue.push(call);
        pump();
      });
    },
  };
}
