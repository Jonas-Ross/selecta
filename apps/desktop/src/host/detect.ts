// Which agent CLIs are installed and signed in, so the brief only offers ones
// that can run. Checked when asked, never cached: installing one mid-session counts.
import { execFile as nodeExecFile } from 'node:child_process';
import type { ProviderId, ProviderStatus } from '../shared/protocol.js';
import type { AgentProvider } from './providers.js';

type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number },
  callback: (error: (Error & { code?: unknown }) | null) => void,
) => unknown;

const run = (execFile: ExecFile, file: string, args: string[]) =>
  new Promise<(Error & { code?: unknown }) | null>((resolve) => {
    execFile(file, args, { timeout: 10_000 }, (error) => resolve(error));
  });

export async function detectProviders(
  providers: AgentProvider[],
  paths: Partial<Record<ProviderId, string>> = {},
  execFile: ExecFile = nodeExecFile as ExecFile,
): Promise<ProviderStatus[]> {
  return Promise.all(
    providers.map(
      async ({ id, label, bin, missing, loginCheck, login }): Promise<ProviderStatus> => {
        const file = paths[id] ?? bin;
        const version = await run(execFile, file, ['--version']);

        if (version)
          return {
            id,
            label,
            ready: false,
            problem: version.code === 'ENOENT' ? missing : version.message,
          };

        if (await run(execFile, file, loginCheck))
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
