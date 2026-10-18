import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { WORKER_SCRIPT, createJxaWorker } from '../src/bridge/jxa.js';
import { wrapJxaScript } from '../src/bridge/scripts/wrap.js';

// A raw string is written as the line itself, except 'hang' and 'die'.
type Answer = { out?: string; err?: string } | string;
type Spawned = {
  args: string[];
  scripts: string[];
  stdin: PassThrough;
  stdout: PassThrough;
  killed?: string;
};

// A stand-in osascript that answers each script line with what `reply` says. Like a real
// child, a kill closes it on a later tick.
function fakeSpawn(reply: (script: string, index: number) => Answer) {
  const spawned: Spawned[] = [];
  const spawn = ((_cmd: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: (signal: string) => {
        record.killed = signal;
        close();
      },
    });
    const record: Spawned = { args, scripts: [], stdin: child.stdin, stdout: child.stdout };
    const close = () => setTimeout(() => child.emit('close', null, null));
    const index = spawned.push(record) - 1;

    createInterface({ input: child.stdin }).on('line', (line) => {
      const script = JSON.parse(line) as string;

      record.scripts.push(script);

      const answer = reply(script, index);

      if (answer === 'die') {
        child.stderr.write('execution error: Error: osascript fell over (-2700)\n');
        close();
      } else if (answer !== 'hang')
        child.stdout.write(`${typeof answer === 'string' ? answer : JSON.stringify(answer)}\n`);
    });

    return child;
  }) as never;

  return { spawn, spawned };
}

it('answers calls in order from one osascript', async () => {
  const { spawn, spawned } = fakeSpawn((script) => ({ out: JSON.stringify({ echo: script }) }));
  const worker = createJxaWorker({ spawn });

  const answers = await Promise.all([worker.run('a'), worker.run('b'), worker.run('ü')]);

  expect(answers).toEqual([{ echo: 'a' }, { echo: 'b' }, { echo: 'ü' }]);
  expect(spawned).toHaveLength(1);
  expect(spawned[0]!.args).toEqual(['-l', 'JavaScript', '-e', WORKER_SCRIPT]);
});

it('maps script errors like a spawned osascript, and survives a line that is no answer', async () => {
  const { spawn } = fakeSpawn((script) =>
    script === 'garbled' ? { out: 'not json' } : script === 'null' ? 'null' : { out: '1' },
  );
  const worker = createJxaWorker({ spawn });

  await expect(worker.run('garbled')).rejects.toMatchObject({ errorCode: 'jxa_error' });
  await expect(worker.run('null')).rejects.toMatchObject({ errorCode: 'jxa_error' });
  await expect(worker.run('ok')).resolves.toBe(1);
});

it('asks again from a fresh osascript after a permission denial', async () => {
  const { spawn, spawned } = fakeSpawn((_script, index) =>
    index === 0
      ? { err: 'Error: Not authorized to send Apple events to Music. (-1743)' }
      : { out: '1' },
  );
  const worker = createJxaWorker({ spawn });

  await expect(worker.run('first')).rejects.toMatchObject({
    errorCode: 'automation_permission_denied',
  });
  await expect(worker.run('second')).resolves.toBe(1);
  expect(spawned).toHaveLength(2);
  expect(spawned[0]!.stdin.writableEnded).toBe(true);
});

it('fails a call past its deadline as unknown, and never sends the next to the dying worker', async () => {
  const { spawn, spawned } = fakeSpawn((script, index) =>
    script === 'slow' ? 'hang' : { out: JSON.stringify(`${script} on ${index}`) },
  );
  const worker = createJxaWorker({ spawn, deadlineMs: 20 });
  const slow = worker.run('slow');
  const next = worker.run('next');

  await expect(slow).rejects.toMatchObject({
    errorCode: 'jxa_error',
    hint: expect.stringContaining('outcome is unknown'),
  });
  expect(spawned[0]!.killed).toBe('SIGKILL');
  await expect(next).resolves.toBe('next on 1');
  expect(spawned[0]!.scripts).toEqual(['slow']);
});

it("ignores what a killed worker still writes, so it can't answer a later call", async () => {
  const { spawn, spawned } = fakeSpawn(() => 'hang');
  const worker = createJxaWorker({ spawn, deadlineMs: 20 });

  await expect(worker.run('slow')).rejects.toMatchObject({ errorCode: 'jxa_error' });

  const next = worker.run('next');
  const answer = (index: number, out: string) =>
    spawned[index]!.stdout.write(`${JSON.stringify({ out: JSON.stringify(out) })}\n`);

  // The slow call's answer lands while the next call is out on a new worker.
  await new Promise((resolve) => setTimeout(resolve));
  answer(0, 'slow');
  await new Promise((resolve) => setTimeout(resolve));
  answer(1, 'next');
  await expect(next).resolves.toBe('next');
});

it('reports a worker that falls over with what it said', async () => {
  const { spawn } = fakeSpawn((script) => (script === 'crash' ? 'die' : { out: '3' }));
  const worker = createJxaWorker({ spawn });

  await expect(worker.run('crash')).rejects.toMatchObject({
    errorCode: 'jxa_error',
    message: expect.stringContaining('osascript fell over'),
  });
  await expect(worker.run('after')).resolves.toBe(3);
});

it('refuses a call that waited out the deadline without reaching Music', async () => {
  const { spawn, spawned } = fakeSpawn(() => 'hang');
  const worker = createJxaWorker({ spawn, deadlineMs: 20 });
  // The third is still queued once the first has used up the deadline and the second has started.
  const [first, second, third] = await Promise.allSettled(
    ['first', 'second', 'third'].map((script) => worker.run(script)),
  );

  expect(third).toMatchObject({ reason: { writePhase: 'not_started' } });

  for (const sent of [first, second])
    expect(sent).toMatchObject({ reason: { hint: expect.stringContaining('outcome is unknown') } });

  expect(spawned.flatMap((s) => s.scripts)).toEqual(['first', 'second']);
});

// The loop itself, against a stand-in for the ObjC bridge it reads stdin and writes stdout through.
function runLoop(chunks: string[]) {
  const written: string[] = [];
  const data = (s: string) => ({ length: s.length, s });
  const $ = Object.assign((s: string) => ({ dataUsingEncoding: () => data(s) }), {
    NSUTF8StringEncoding: 4,
    NSFileHandle: {
      fileHandleWithStandardInput: {
        get availableData() {
          return data(chunks.shift() ?? '');
        },
      },
      fileHandleWithStandardOutput: { writeData: (d: { s: string }) => written.push(d.s) },
    },
    NSString: { alloc: { initWithDataEncoding: (d: { s: string }) => ({ js: d.s }) } },
  });

  runInNewContext(WORKER_SCRIPT, { $, ObjC: { import: () => {} }, Application: () => ({}) });

  return written.map((line) => JSON.parse(line) as { out?: string; err?: string });
}

it('frames scripts across reads, keeps each in its own scope, and keeps going after an error', () => {
  const line = (body: string, args: object = {}) =>
    `${JSON.stringify(wrapJxaScript(args, body))}\n`;
  const n = (value: number) => line('return JSON.stringify(args.n);', { n: value });
  const failing = line('throw Object.assign(new Error("Not authorized"), { errorNumber: -1743 });');
  const split = n(3);

  // Two scripts in one read, one split across two reads, a failure, then one more.
  expect(runLoop([n(1) + n(2), split.slice(0, 10), split.slice(10), failing, n(4)])).toEqual([
    { out: '1' },
    { out: '2' },
    { out: '3' },
    { err: 'Error: Not authorized (-1743)' },
    { out: '4' },
  ]);
  expect(WORKER_SCRIPT).not.toMatch(/function run\s*\(/);
});
