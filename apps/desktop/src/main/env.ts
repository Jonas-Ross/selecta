// A packaged app opened from Finder gets launchd's bare PATH, which has none of
// the places claude, codex or metrognome install to, so the host gets the login shell's.
import { execFileSync } from 'node:child_process';
import { delimiter, join } from 'node:path';

const MARK = '__SELECTA_PATH__';

// Where the agent CLIs and Homebrew install, for when the shell can't be asked.
export const FALLBACK_DIRS = (home: string) => [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(home, '.local/bin'),
];

/** The PATH between the marks, since an interactive shell may print a banner around it. */
export function markedPath(output: string): string | undefined {
  const found = new RegExp(`${MARK}(.*)${MARK}`).exec(output);

  return found?.[1] || undefined;
}

export function loginShellPath(shell: string, run = execFileSync): string | undefined {
  try {
    const output = run(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return markedPath(output);
  } catch {
    return undefined;
  }
}

/** The shell's PATH, else launchd's plus the usual install dirs; the bundled Node goes last so the user's own wins. */
export function packagedPath(
  env: NodeJS.ProcessEnv,
  home: string,
  bundledBin: string,
  shellPath: string | undefined,
): string {
  const dirs = (shellPath ?? [env.PATH ?? '', ...FALLBACK_DIRS(home)].join(delimiter))
    .split(delimiter)
    .filter(Boolean);

  return [...new Set([...dirs, bundledBin])].join(delimiter);
}
