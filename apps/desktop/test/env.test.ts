import { describe, expect, it } from 'vitest';
import { loginShellPath, markedPath, packagedPath } from '../src/main/env.js';

describe('markedPath', () => {
  it('reads the PATH from between the marks, past a shell banner', () => {
    expect(markedPath('Welcome back!\n__SELECTA_PATH__/a:/b__SELECTA_PATH__')).toBe('/a:/b');
  });

  it('gives nothing when the marks are missing or empty', () => {
    expect(markedPath('/a:/b')).toBeUndefined();
    expect(markedPath('__SELECTA_PATH____SELECTA_PATH__')).toBeUndefined();
  });
});

describe('loginShellPath', () => {
  it('gives nothing when the shell fails', () => {
    const run = (() => {
      throw new Error('timed out');
    }) as never;

    expect(loginShellPath('/bin/zsh', run)).toBeUndefined();
  });
});

describe('packagedPath', () => {
  it("uses the shell's PATH and puts the bundled Node last", () => {
    expect(packagedPath({}, '/Users/j', '/App/core', '/Users/j/.local/bin:/usr/bin')).toBe(
      '/Users/j/.local/bin:/usr/bin:/App/core',
    );
  });

  it("falls back to launchd's PATH plus Homebrew and ~/.local/bin, without repeats", () => {
    expect(
      packagedPath({ PATH: '/usr/bin:/bin:/usr/local/bin' }, '/Users/j', '/App/core', undefined),
    ).toBe('/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:/Users/j/.local/bin:/App/core');
  });
});
