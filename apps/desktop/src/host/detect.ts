// Which agent CLIs are installed and signed in, so the brief only offers ones
// that can run. Checked when asked, never cached: installing one mid-session counts.
import { execFile as nodeExecFile } from 'node:child_process';
import type { ProviderId, ProviderStatus } from '../shared/protocol.js';
import type { AgentProvider } from './providers.js';

type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number },
  callback: (error: (Error & { code?: unknown }) | null, stdout?: string | Buffer) => void,
) => unknown;

type Ran = { error: (Error & { code?: unknown }) | null; stdout: string };

const run = (execFile: ExecFile, file: string, args: string[]) =>
  new Promise<Ran>((resolve) => {
    execFile(file, args, { timeout: 10_000 }, (error, stdout) =>
      resolve({ error, stdout: String(stdout ?? '') }),
    );
  });

const parts = (version: string) => version.split('.').map(Number);

/** False when `output` names no version, so an unreadable one is not trusted. */
export function atLeast(output: string, floor: string): boolean {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(output);

  if (!found) return false;

  const have = found.slice(1).map(Number);
  const need = parts(floor);
  const at = have.findIndex((part, index) => part !== need[index]);

  return at === -1 || have[at] > need[at];
}

export async function detectProviders(
  providers: AgentProvider[],
  paths: Partial<Record<ProviderId, string>> = {},
  execFile: ExecFile = nodeExecFile as ExecFile,
): Promise<ProviderStatus[]> {
  return Promise.all(
    providers.map(
      async ({
        id,
        label,
        bin,
        missing,
        minVersion,
        loginCheck,
        login,
      }): Promise<ProviderStatus> => {
        const file = paths[id] ?? bin;
        const { error, stdout } = await run(execFile, file, ['--version']);

        if (error)
          return {
            id,
            label,
            ready: false,
            problem: error.code === 'ENOENT' ? missing : error.message,
          };

        if (minVersion && !atLeast(stdout, minVersion))
          return {
            id,
            label,
            ready: false,
            problem: `Update ${label} to ${minVersion} or newer.`,
          };

        if ((await run(execFile, file, loginCheck)).error)
          return {
            id,
            label,
            ready: false,
            problem: `Sign in first: run ${login} in a terminal.`,
          };

        return { id, label, ready: true };
      },
    ),
  );
}
