import { expect, it } from 'vitest';
import { detectProviders } from '../src/host/detect.js';
import { claude, codex } from '../src/host/providers.js';

type Done = (error: (Error & { code?: unknown }) | null) => void;

const fail = (message: string, code: unknown) => Object.assign(new Error(message), { code });

it('offers only installed, signed-in CLIs and says why the others cannot run', async () => {
  const calls: string[] = [];
  const answers: Record<string, Error | null> = {
    'claude --version': null,
    'claude auth status': fail('Not logged in', 1),
    '/opt/codex --version': null,
    '/opt/codex login status': null,
  };
  const execFile = (file: string, args: string[], _options: unknown, done: Done) => {
    const call = `${file} ${args.join(' ')}`;

    calls.push(call);
    done(answers[call] ?? null);
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
