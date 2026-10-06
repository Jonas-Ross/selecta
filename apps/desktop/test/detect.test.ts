import { expect, it } from 'vitest';
import { detectProviders } from '../src/host/detect.js';
import { claude, codex } from '../src/host/providers.js';

it('offers an installed, signed-in CLI and says why the others cannot run', async () => {
  const calls: string[] = [];
  const execFile = (
    file: string,
    args: string[],
    _options: unknown,
    done: (error: (Error & { code?: unknown }) | null) => void,
  ) => {
    calls.push(`${file} ${args.join(' ')}`);

    if (file === 'claude')
      done(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    else if (args[0] === 'login') done(Object.assign(new Error('Not logged in'), { code: 1 }));
    else done(null);
  };

  expect(await detectProviders([claude, codex], { codex: '/opt/codex' }, execFile)).toEqual([
    { id: 'claude', label: 'Claude', ready: false, problem: claude.missing },
    {
      id: 'codex',
      label: 'Codex',
      ready: false,
      problem: 'Sign in first: run codex login in a terminal.',
    },
  ]);
  expect(calls).toEqual(['claude --version', '/opt/codex --version', '/opt/codex login status']);
});
