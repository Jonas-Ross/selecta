import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { runJxa } from '../src/bridge/jxa.js';
import { BridgeError, type ErrorCode } from '../src/types/errors.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

// Drive the execFile callback the way Node does: (error, stdout, stderr).
// On non-zero exit, `error` is an Error carrying the exit code; stdout/stderr
// are still delivered.
function stubExecFile(opts: {
  error?: Error | null;
  stdout?: string;
  stderr?: string;
}): void {
  mockExecFile.mockImplementation(((
    _cmd: string,
    _args: readonly string[],
    _options: object,
    cb: (e: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cb(opts.error ?? null, opts.stdout ?? '', opts.stderr ?? '');
    return {} as never;
  }) as never);
}

async function expectErrorCode(p: Promise<unknown>, code: ErrorCode): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(BridgeError);
  await expect(p).rejects.toMatchObject({ errorCode: code });
}

describe('runJxa', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('parses stdout JSON on success', async () => {
    stubExecFile({ stdout: '{"persistentId":"ABC","name":"x"}' });
    await expect(runJxa('noop')).resolves.toEqual({ persistentId: 'ABC', name: 'x' });
  });

  it('throws jxa_error when stdout is not valid JSON', async () => {
    stubExecFile({ stdout: 'not json at all' });
    await expectErrorCode(runJxa('noop'), 'jxa_error');
  });

  it('maps a macOS automation privilege denial to automation_permission_denied', async () => {
    stubExecFile({
      error: new Error('Command failed'),
      stderr:
        'execution error: Not authorized to send Apple events to Music. (-1743) errAEPrivilegeError',
    });
    await expectErrorCode(runJxa('noop'), 'automation_permission_denied');
  });

  it('maps an app-not-running signature to music_app_not_running', async () => {
    stubExecFile({
      error: new Error('Command failed'),
      stderr: "execution error: Application isn't running. (-600)",
    });
    await expectErrorCode(runJxa('noop'), 'music_app_not_running');
  });

  it('maps any other non-zero exit to jxa_error', async () => {
    stubExecFile({
      error: new Error('Command failed'),
      stderr: 'execution error: something unexpected happened (-2700)',
    });
    await expectErrorCode(runJxa('noop'), 'jxa_error');
  });
});
