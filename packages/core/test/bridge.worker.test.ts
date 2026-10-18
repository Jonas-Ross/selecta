import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWarmJxa, runWarmJxa, WORKER_MARKER } from '../src/bridge/worker.js';

// A stand-in osascript on PATH that speaks the worker's line protocol, evaluating
// each script in Node. It tests the pool's plumbing, not what Music.app does.
const FAKE = `#!/usr/bin/env node
const { createInterface } = require('node:readline');
const script = process.argv[process.argv.indexOf('-e') + 1];
if (!script.startsWith(${JSON.stringify(WORKER_MARKER)})) process.exit(9);
(async () => {
  for await (const line of createInterface({ input: process.stdin })) {
    try { process.stdout.write(JSON.stringify({ out: String(await (0, eval)(JSON.parse(line))) }) + '\\n'); }
    catch (e) { process.stdout.write(JSON.stringify({ err: 'execution error: ' + e.message }) + '\\n'); }
  }
})();
`;

let dir: string;
const path = process.env.PATH;
const pid = 'JSON.stringify(process.pid)';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'selecta-worker-'));
  writeFileSync(join(dir, 'osascript'), FAKE);
  chmodSync(join(dir, 'osascript'), 0o755);
  process.env.PATH = `${dir}:${path}`;
});

afterEach(() => closeWarmJxa());

afterAll(() => {
  process.env.PATH = path;
  rmSync(dir, { recursive: true, force: true });
});

describe('runWarmJxa', () => {
  it('parses the script result and reuses one process across sequential calls', async () => {
    await expect(runWarmJxa('JSON.stringify({ a: 1 })')).resolves.toEqual({ a: 1 });

    const first = await runWarmJxa(pid);

    await expect(runWarmJxa(pid)).resolves.toBe(first);
  });

  it('runs concurrent calls in separate processes', async () => {
    const slow = `new Promise((r) => setTimeout(() => r(${pid}), 50))`;
    const pids = await Promise.all([runWarmJxa(slow), runWarmJxa(slow)]);

    expect(new Set(pids).size).toBe(2);
  });

  it('maps script errors the way a one-shot osascript does, and keeps the worker', async () => {
    const before = await runWarmJxa(pid);

    await expect(
      runWarmJxa("throw new Error('Not authorized to send Apple events to Music. (-1743)')"),
    ).rejects.toMatchObject({ errorCode: 'automation_permission_denied' });
    await expect(
      runWarmJxa('throw new Error("Application isn\'t running. (-600)")'),
    ).rejects.toMatchObject({
      errorCode: 'music_app_not_running',
    });
    await expect(runWarmJxa("'not json'")).rejects.toMatchObject({ errorCode: 'jxa_error' });
    await expect(runWarmJxa(pid)).resolves.toBe(before);
  });

  it('fails a call whose worker dies, without retrying it, and starts a fresh one next', async () => {
    const before = await runWarmJxa(pid);

    await expect(runWarmJxa('process.exit(3)')).rejects.toMatchObject({ errorCode: 'jxa_error' });
    await expect(runWarmJxa(pid)).resolves.not.toBe(before);
  });

  it('kills a call past its deadline and reports the outcome as unknown', async () => {
    const before = await runWarmJxa(pid);

    await expect(runWarmJxa('new Promise(() => {})', 100)).rejects.toMatchObject({
      errorCode: 'jxa_error',
      hint: expect.stringContaining('outcome is unknown'),
    });
    await expect(runWarmJxa(pid)).resolves.not.toBe(before);
  });
});
