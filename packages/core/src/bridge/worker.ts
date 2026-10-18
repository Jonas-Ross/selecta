// Long-lived osascript processes for the calls a screen makes every second.
// A fresh osascript costs ~100 ms to start before Music sees a single Apple
// event; a warm one answers a player read in ~8 ms. Each worker runs one
// script at a time, so concurrent calls take another worker, as separate
// spawns would. A failed or interrupted call is never retried.

import { spawn, type ChildProcess } from 'node:child_process';
import { type BridgeError } from '../types/errors.js';
import {
  interruptedError,
  JXA_TIMEOUT_MS,
  jxaError,
  jxaFailure,
  MAX_STDOUT_BYTES,
  parseJxaStdout,
} from './osascript.js';

/** First line of the worker's source, so a stand-in osascript can tell a worker from a one-shot. */
export const WORKER_MARKER = '// selecta-jxa-worker';

// Reads one JSON-encoded script per line and answers each with one JSON line.
// Indirect eval runs it as osascript -e would, at top level, returning the last
// expression; each eval gets its own scope for the script's `const`s.
const WORKER_SOURCE = `${WORKER_MARKER}
ObjC.import('Foundation');
(function () {
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  const output = $.NSFileHandle.fileHandleWithStandardOutput;
  const send = function (reply) {
    output.writeData($(JSON.stringify(reply) + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
  };
  let pending = '';
  for (;;) {
    const data = input.availableData;
    // The bridge hands NSData's length over as a string; zero is the parent gone.
    if (Number(data.length) === 0) return;
    pending += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
    let end;
    while ((end = pending.indexOf('\\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line === '') continue;
      try {
        send({ out: String((0, eval)(JSON.parse(line))) });
      } catch (e) {
        send({ err: 'execution error: ' + String(e) + (e && e.errorNumber !== undefined ? ' (' + e.errorNumber + ')' : '') });
      }
    }
  }
})();
`;

// Kept warm between polls; the rest exit once their call ends.
const MAX_IDLE = 2;
const IDLE_EXIT_MS = 60_000;
// JXA never drains its autorelease pool inside one script, so a worker is replaced
// before what it leaks per call can add up.
const MAX_CALLS = 500;

// The worker decodes each read on its own, so a character split across two reads
// could fail to decode; escaped, every request is plain ASCII.
const ascii = (json: string) =>
  json.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

type Reply = { out: string } | { err: string };
type Refable = { ref(): void; unref(): void } | null;

const idle: Worker[] = [];

class Worker {
  readonly child: ChildProcess;
  calls = 0;
  dead = false;
  private chunks: string[] = [];
  private size = 0;
  private stderr = '';
  private idleTimer?: ReturnType<typeof setTimeout>;
  private waiting?: { resolve: (reply: Reply) => void; reject: (error: BridgeError) => void };

  constructor() {
    this.child = spawn('osascript', ['-l', 'JavaScript', '-e', WORKER_SOURCE], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => this.read(chunk));
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4096);
    });
    // A write to a worker that just died surfaces through 'exit' instead.
    this.child.stdin!.on('error', () => {});
    this.child.on('error', (error) => this.died(error.message));
    this.child.on('exit', () => this.died('worker exited'));
  }

  run(script: string): Promise<Reply> {
    this.calls++;
    this.stderr = '';
    this.hold(true);

    return new Promise<Reply>((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.child.stdin!.write(`${ascii(JSON.stringify(script))}\n`);
    }).finally(() => {
      this.waiting = undefined;
      this.hold(false);
    });
  }

  /** Kills the process and fails the call in progress with `error`. */
  abort(error: BridgeError) {
    this.dead = true;
    this.child.kill('SIGKILL');
    this.waiting?.reject(error);
  }

  /** Waits in the pool, ending itself if nothing takes it in time. */
  park() {
    idle.push(this);
    this.idleTimer = setTimeout(() => this.retire(), IDLE_EXIT_MS);
    this.idleTimer.unref();
  }

  unpark() {
    clearTimeout(this.idleTimer);

    const at = idle.indexOf(this);

    if (at >= 0) idle.splice(at, 1);
  }

  /** Leaves the pool; the process exits once its input closes. */
  retire() {
    this.unpark();
    this.child.stdin!.end();
  }

  // An idle worker must not keep a CLI process alive; a busy one must, or the
  // process could exit with the call still pending.
  private hold(on: boolean) {
    const { stdin, stdout, stderr } = this.child;

    // The pipes are sockets at runtime, though typed as plain streams.
    for (const handle of [this.child, stdin, stdout, stderr] as unknown as Refable[])
      if (on) handle?.ref();
      else handle?.unref();
  }

  // Only the new chunk is searched, so a long reply isn't rescanned per read.
  private read(chunk: string) {
    this.size += chunk.length;

    if (this.size > MAX_STDOUT_BYTES) return this.abort(interruptedError());

    const end = chunk.indexOf('\n');

    if (end < 0) {
      this.chunks.push(chunk);

      return;
    }

    const line = this.chunks.join('') + chunk.slice(0, end);
    const rest = chunk.slice(end + 1);

    this.chunks = [rest];
    this.size = rest.length;

    try {
      this.waiting?.resolve(JSON.parse(line) as Reply);
    } catch {
      this.abort(
        jxaError('jxa_error', `osascript worker sent unparseable output: ${line.slice(0, 200)}`),
      );
    }
  }

  private died(fallback: string) {
    this.dead = true;
    this.unpark();
    this.waiting?.reject(jxaFailure(this.stderr, fallback));
  }
}

function take(): Worker {
  const worker = idle.at(-1);

  if (!worker) return new Worker();

  worker.unpark();

  return worker;
}

/** runJxa on a warm osascript: the same errors, deadline and output limit. */
export async function runWarmJxa(script: string, timeoutMs = JXA_TIMEOUT_MS): Promise<unknown> {
  const worker = take();
  const deadline = setTimeout(() => worker.abort(interruptedError()), timeoutMs);
  let reply: Reply;

  try {
    reply = await worker.run(script);
  } finally {
    clearTimeout(deadline);

    if (!worker.dead) {
      if (idle.length >= MAX_IDLE || worker.calls >= MAX_CALLS) worker.retire();
      else worker.park();
    }
  }

  if ('err' in reply) throw jxaFailure(reply.err);

  return parseJxaStdout(reply.out);
}

/** Ends the idle workers; a busy one exits once its call returns. */
export function closeWarmJxa() {
  for (const worker of idle.slice()) worker.retire();
}
