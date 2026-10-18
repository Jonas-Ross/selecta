import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { WORKER_SCRIPT, createJxaWorker } from '../src/bridge/jxa.js';

type Answer = { out?: string; err?: string } | 'hang' | 'die';

// A stand-in osascript that answers each script line with what `reply` says.
function fakeSpawn(reply: (script: string) => Answer) {
  const spawned: { args: string[]; scripts: string[]; killed?: string }[] = [];
  const spawn = ((_cmd: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: (signal: string) => {
        record.killed = signal;
        child.emit('exit', null, signal);
      },
    });
    const record = { args, scripts: [] as string[], killed: undefined as string | undefined };

    spawned.push(record);

    void (async () => {
      for await (const line of createInterface({ input: child.stdin })) {
        const script = JSON.parse(line) as string;

        record.scripts.push(script);

        const answer = reply(script);

        if (answer === 'die') child.emit('exit', 1, null);
        else if (answer !== 'hang') child.stdout.write(`${JSON.stringify(answer)}\n`);
      }
    })();

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

it('maps script errors like a spawned osascript, and keeps serving', async () => {
  const { spawn } = fakeSpawn((script) =>
    script === 'denied'
      ? { err: 'Error: Not authorized to send Apple events to Music. (-1743)' }
      : script === 'garbled'
        ? { out: 'not json' }
        : { out: '1' },
  );
  const worker = createJxaWorker({ spawn });

  await expect(worker.run('denied')).rejects.toMatchObject({
    errorCode: 'automation_permission_denied',
  });
  await expect(worker.run('garbled')).rejects.toMatchObject({ errorCode: 'jxa_error' });
  await expect(worker.run('ok')).resolves.toBe(1);
});

it('kills a call past its deadline, reports its outcome unknown, and starts afresh', async () => {
  const { spawn, spawned } = fakeSpawn((script) => (script === 'slow' ? 'hang' : { out: '2' }));
  const worker = createJxaWorker({ spawn, deadlineMs: 20 });
  const slow = worker.run('slow');
  const next = worker.run('next');

  await expect(slow).rejects.toMatchObject({
    errorCode: 'jxa_error',
    hint: expect.stringContaining('outcome is unknown'),
  });
  expect(spawned[0]!.killed).toBe('SIGKILL');
  // The call waiting behind it never reached the dead worker, so it runs on a new one.
  await expect(next).resolves.toBe(2);
  expect(spawned).toHaveLength(2);
  expect(spawned[1]!.scripts).toEqual(['next']);
});

it('reports a worker that dies mid-call as interrupted', async () => {
  const { spawn } = fakeSpawn((script) => (script === 'crash' ? 'die' : { out: '3' }));
  const worker = createJxaWorker({ spawn });

  await expect(worker.run('crash')).rejects.toMatchObject({
    hint: expect.stringContaining('outcome is unknown'),
  });
  await expect(worker.run('after')).resolves.toBe(3);
});

it('keeps each script in its own scope, so a second `const args` is no clash', async () => {
  const { wrapJxaScript } = await import('../src/bridge/scripts/wrap.js');
  // The loop's evaluator, sloppy as JXA's top level is, with Application stubbed.
  // oxlint-disable-next-line typescript/no-implied-eval -- runs the worker's own evaluator
  const one = new Function('Application', 'src', 'return eval(src);') as (
    app: () => object,
    src: string,
  ) => unknown;
  const script = (n: number) => wrapJxaScript({ n }, 'return JSON.stringify(args.n);');

  expect(WORKER_SCRIPT).toContain('function selectaOne(src) { return eval(src); }');
  expect(WORKER_SCRIPT).not.toMatch(/function run\s*\(/);
  expect([one(() => ({}), script(1)), one(() => ({}), script(2))]).toEqual(['1', '2']);
});
