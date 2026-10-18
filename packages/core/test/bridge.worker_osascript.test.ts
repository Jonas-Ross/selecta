import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { closeWarmJxa, runWarmJxa } from '../src/bridge/worker.js';

// The real osascript, with a script that never addresses Music.app: JXA's own
// quirks, such as how the ObjC bridge hands over NSData's length, decide whether
// a worker notices its parent has gone.
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

describe.runIf(existsSync('/usr/bin/osascript'))('the real osascript worker', () => {
  it('exits once its input closes, so none outlives the process that started it', async () => {
    const pid = (await runWarmJxa(
      "ObjC.import('Foundation'); JSON.stringify($.NSProcessInfo.processInfo.processIdentifier)",
    )) as number;

    expect(alive(pid)).toBe(true);
    closeWarmJxa();
    await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
  });
});
