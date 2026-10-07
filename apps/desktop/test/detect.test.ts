import { expect, it } from 'vitest';
import { atLeast, detectProviders } from '../src/host/detect.js';
import { claude, codex } from '../src/host/providers.js';

type Done = (error: (Error & { code?: unknown }) | null, stdout?: string) => void;

const fail = (message: string, code: unknown) => Object.assign(new Error(message), { code });

it('offers only installed, signed-in CLIs and says why the others cannot run', async () => {
  const calls: string[] = [];
  const answers: Record<string, Error | string> = {
    'claude --version': '2.1.292 (Claude Code)',
    'claude auth status': fail('Not logged in', 1),
    '/opt/codex --version': 'codex-cli 0.160.1',
    '/opt/codex login status': '',
  };
  const execFile = (file: string, args: string[], _options: unknown, done: Done) => {
    const call = `${file} ${args.join(' ')}`;

    calls.push(call);
    const answer = answers[call] ?? '';

    if (answer instanceof Error) done(answer);
    else done(null, answer);
  };

  expect(await detectProviders([claude, codex], { codex: '/opt/codex' }, execFile)).toEqual([
    {
      id: 'claude',
      label: 'Claude',
      ready: false,
      problem: 'Sign in first: run claude auth login in a terminal.',
    },
    { id: 'codex', label: 'Codex', ready: true },
  ]);
  expect(calls).toEqual([
    'claude --version',
    '/opt/codex --version',
    'claude auth status',
    '/opt/codex login status',
  ]);

  answers['/opt/codex --version'] = fail('spawn /opt/codex ENOENT', 'ENOENT');

  expect((await detectProviders([codex], { codex: '/opt/codex' }, execFile))[0].problem).toBe(
    codex.missing,
  );
});

it('holds back a Codex too old to keep its own tools off', async () => {
  const execFile = (file: string, args: string[], _options: unknown, done: Done) =>
    done(null, args[0] === '--version' ? 'codex-cli 0.140.0' : '');

  expect(await detectProviders([codex], {}, execFile)).toEqual([
    { id: 'codex', label: 'Codex', ready: false, problem: 'Update Codex to 0.150.0 or newer.' },
  ]);
});

it('compares versions numerically and distrusts output without one', () => {
  expect(atLeast('codex-cli 0.150.0', '0.150.0')).toBe(true);
  expect(atLeast('codex-cli 0.160.1', '0.150.0')).toBe(true);
  expect(atLeast('codex-cli 1.0.0', '0.150.0')).toBe(true);
  expect(atLeast('codex-cli 0.99.9', '0.150.0')).toBe(false);
  expect(atLeast('codex-cli 0.122.0', '0.150.0')).toBe(false);
  expect(atLeast('codex-cli', '0.150.0')).toBe(false);
});
