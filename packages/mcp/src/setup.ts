// `selecta setup`: register this build with the Claude clients on this Mac and
// say what else is missing. Reports by default and writes only with --apply,
// like the destructive cache commands, because it edits files Selecta does not
// own.

import { execFile } from 'node:child_process';
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readStatus } from '@selecta/core/diagnostics/status.js';
import {
  METROGNOME_PATH_ENV,
  type MetrognomeBinary,
} from '@selecta/core/enrich/metrognome_binary.js';
import { BridgeError } from '@selecta/core/types/errors.js';

export const CLIENTS = ['desktop', 'code'] as const;
export type Client = (typeof CLIENTS)[number];

export type StepName = 'claude_desktop' | 'claude_code' | 'metrognome' | 'music_app' | 'library';

/**
 * `ok`: nothing to do. `would_change` / `changed`: a client entry Selecta
 * writes, before and after --apply. `missing`: only the user can fix it.
 * `skipped`: the client is not installed or was not asked for.
 */
export type StepStatus = 'ok' | 'would_change' | 'changed' | 'missing' | 'skipped' | 'error';

export type SetupStep = {
  step: StepName;
  status: StepStatus;
  detail: string;
  fix?: string;
  // The selecta entry as it stood before a change, and where it was saved.
  previous?: unknown;
  backup?: string;
};

export type SetupReport = {
  ok: boolean;
  dry_run: boolean;
  server: ServerEntry;
  steps: SetupStep[];
};

export type ServerEntry = { command: string; args: string[] };

export type CommandResult = { code: number | null; stdout: string; stderr: string };

export type SetupDeps = {
  home: string;
  dbPath: string;
  // How a client should launch this build: absolute node, absolute entry.
  server: ServerEntry;
  // How the user typed this build, for fix lines they can paste.
  invocation: string;
  // Absolute path of an executable on the user's PATH, or null.
  which: (name: string) => string | null;
  run: (command: string, args: string[]) => Promise<CommandResult>;
  musicCheck: () => Promise<void>;
  metrognomeCheck: () => Promise<MetrognomeBinary>;
  // Where Claude Desktop's app bundle may be installed.
  desktopApps?: readonly string[];
  now?: () => Date;
};

const SERVER_NAME = 'selecta';
const README = 'https://github.com/Jonas-Ross/selecta#register-with-an-mcp-client';

export function desktopConfigPath(home: string): string {
  return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
}

// User-scope MCP servers live at the top level of this file; Claude Code owns
// it and rewrites it often, so setup only reads it and writes through `claude`.
export function codeConfigPath(home: string): string {
  return join(home, '.claude.json');
}

/**
 * How a client should launch this build.
 *
 * GUI apps start without the shell's PATH, so both paths are absolute. The node
 * is the user's own `node` when that is this same binary, since Homebrew's
 * Cellar path behind it changes on every upgrade while the link does not.
 */
export function serverEntry(
  entryScript: string,
  execPath = process.execPath,
  which: (name: string) => string | null = whichOnPath,
): ServerEntry {
  const linked = which('node');
  const command = linked != null && sameFile(linked, execPath) ? linked : execPath;

  return { command, args: [entryScript] };
}

export function whichOnPath(name: string, path = process.env.PATH ?? ''): string | null {
  for (const directory of path.split(delimiter)) {
    if (directory === '') continue;

    const candidate = join(directory, name);

    try {
      accessSync(candidate, constants.X_OK);

      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here; keep looking.
    }
  }

  return null;
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err == null ? 0 : typeof err.code === 'number' ? err.code : null;

      resolve({ code, stdout, stderr: stderr || (err != null && code == null ? err.message : '') });
    });
  });
}

/** Command and args are what setup owns; anything else on the entry is the user's. */
function launchesThis(current: unknown, server: ServerEntry): boolean {
  if (current == null || typeof current !== 'object') return false;

  const { command, args } = current as { command?: unknown; args?: unknown };

  return command === server.command && isDeepStrictEqual(args, server.args);
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

type Planned = { step: SetupStep; apply?: () => Promise<SetupStep> };

function planDesktop(deps: SetupDeps, now: Date): Planned {
  const path = desktopConfigPath(deps.home);

  // A freshly installed app has no Application Support folder until first launch.
  const apps = deps.desktopApps ?? [
    '/Applications/Claude.app',
    join(deps.home, 'Applications', 'Claude.app'),
  ];

  if (!existsSync(dirname(path)) && !apps.some((app) => existsSync(app))) {
    return {
      step: {
        step: 'claude_desktop',
        status: 'skipped',
        detail:
          'Claude Desktop is not installed (no Claude.app and no Claude folder in Application Support).',
      },
    };
  }

  let config: Record<string, unknown> = {};
  const exists = existsSync(path);

  if (exists) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      return {
        step: {
          step: 'claude_desktop',
          status: 'error',
          detail: `${path} is not valid JSON (${(err as Error).message}); setup will not rewrite a file it cannot read.`,
          fix: `Fix or move that file, then rerun setup.`,
        },
      };
    }

    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;

    if (
      parsed == null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (servers != null && (typeof servers !== 'object' || Array.isArray(servers)))
    ) {
      return {
        step: {
          step: 'claude_desktop',
          status: 'error',
          detail: `${path} is not the shape Claude Desktop writes (an object with an mcpServers object).`,
          fix: `Fix or move that file, then rerun setup.`,
        },
      };
    }

    config = parsed as Record<string, unknown>;
  }

  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  const previous = servers[SERVER_NAME];

  if (launchesThis(previous, deps.server)) {
    return {
      step: { step: 'claude_desktop', status: 'ok', detail: `Registered in ${path}.` },
    };
  }

  const next: Record<string, unknown> = {
    ...(previous as Record<string, unknown> | undefined),
    command: deps.server.command,
    args: deps.server.args,
  };
  const verb = previous == null ? 'add' : 'replace';

  return {
    step: {
      step: 'claude_desktop',
      status: 'would_change',
      detail: `Would ${verb} the selecta server in ${path}${exists ? ', backing the file up first' : ''}.`,
      ...(previous != null && { previous }),
    },
    apply: async () => {
      const backup = exists ? `${path}.selecta-backup-${stamp(now)}` : undefined;

      if (backup != null) copyFileSync(path, backup);
      else mkdirSync(dirname(path), { recursive: true });

      const body = JSON.stringify(
        { ...config, mcpServers: { ...servers, [SERVER_NAME]: next } },
        null,
        2,
      );
      // A rename never leaves Claude Desktop a half-written config to choke on.
      const temp = `${path}.selecta-${process.pid}.tmp`;

      writeFileSync(temp, body + '\n', { mode: exists ? statSync(path).mode : 0o644 });
      renameSync(temp, path);

      return {
        step: 'claude_desktop',
        status: 'changed',
        detail: `${verb === 'add' ? 'Added' : 'Replaced'} the selecta server in ${path}. Restart Claude Desktop to load it.`,
        ...(previous != null && { previous }),
        ...(backup != null && { backup }),
      };
    },
  };
}

function planCode(deps: SetupDeps, now: Date): Planned {
  const claude = deps.which('claude');

  if (claude == null) {
    return {
      step: {
        step: 'claude_code',
        status: 'skipped',
        detail: 'Claude Code is not installed (no `claude` on PATH).',
      },
    };
  }

  let previous: unknown;

  try {
    const config = JSON.parse(readFileSync(codeConfigPath(deps.home), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };

    previous = config?.mcpServers?.[SERVER_NAME];
  } catch {
    // No user config yet, or one Claude Code is mid-write; `claude mcp add`
    // reports a clash itself.
  }

  if (launchesThis(previous, deps.server)) {
    return {
      step: { step: 'claude_code', status: 'ok', detail: 'Registered at user scope.' },
    };
  }

  const env = (previous as { env?: Record<string, string> } | undefined)?.env ?? {};
  const addArgs = [
    'mcp',
    'add',
    '--scope',
    'user',
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    SERVER_NAME,
    '--',
    deps.server.command,
    ...deps.server.args,
  ];
  const verb = previous == null ? 'add' : 'replace';

  return {
    step: {
      step: 'claude_code',
      status: 'would_change',
      detail: `Would ${verb} the selecta server at user scope with \`claude mcp add\`.`,
      ...(previous != null && { previous }),
    },
    apply: async () => {
      let backup: string | undefined;

      if (previous != null) {
        // Claude Code owns ~/.claude.json, so the backup is the entry alone.
        backup = join(dirname(deps.dbPath), 'setup-backups', `claude-code-${stamp(now)}.json`);
        mkdirSync(dirname(backup), { recursive: true });
        writeFileSync(backup, JSON.stringify({ [SERVER_NAME]: previous }, null, 2) + '\n');

        const removed = await deps.run(claude, ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);

        if (removed.code !== 0) return codeFailure('remove', removed, previous, backup);
      }

      const added = await deps.run(claude, addArgs);

      if (added.code !== 0) {
        const failure = codeFailure('add', added, previous, backup);

        if (previous == null) return failure;

        // Put the old registration back rather than leave the user with none.
        const restored = await deps.run(claude, [
          'mcp',
          'add-json',
          '--scope',
          'user',
          SERVER_NAME,
          JSON.stringify(previous),
        ]);

        return {
          ...failure,
          detail: `${failure.detail}. ${restored.code === 0 ? 'The previous entry was restored.' : `Restoring the previous entry also failed, so Claude Code has no selecta server; it is saved in ${backup}.`}`,
        };
      }

      return {
        step: 'claude_code',
        status: 'changed',
        detail: `${verb === 'add' ? 'Added' : 'Replaced'} the selecta server at user scope. Start a new Claude Code session to load it.`,
        ...(previous != null && { previous }),
        ...(backup != null && { backup }),
      };
    },
  };
}

function codeFailure(
  action: string,
  result: CommandResult,
  previous: unknown,
  backup: string | undefined,
): SetupStep {
  const output = (result.stderr || result.stdout).trim();

  return {
    step: 'claude_code',
    status: 'error',
    detail: `\`claude mcp ${action}\` failed (exit ${result.code ?? 'unknown'})${output ? `: ${output}` : ''}`,
    fix: `Register it by hand: ${README}`,
    ...(previous != null && { previous }),
    ...(backup != null && { backup }),
  };
}

async function checkMetrognome(deps: SetupDeps): Promise<SetupStep> {
  try {
    const { path, version } = await deps.metrognomeCheck();

    return { step: 'metrognome', status: 'ok', detail: `metrognome ${version} at ${path}.` };
  } catch (err) {
    return {
      step: 'metrognome',
      status: 'missing',
      detail: `${err instanceof Error ? err.message : String(err)} Without it \`enrich --source analysis\` skips every track; tempo and key then come from the catalogs alone.`,
      fix: `brew install jonas-ross/tap/metrognome (or brew upgrade metrognome), or point ${METROGNOME_PATH_ENV} at the binary.`,
    };
  }
}

async function checkMusicApp(deps: SetupDeps): Promise<SetupStep> {
  try {
    await deps.musicCheck();

    return {
      step: 'music_app',
      status: 'ok',
      // macOS grants Automation per app, so each client asks once on first use.
      detail:
        'Music.app answered and this terminal may automate it. Claude Desktop asks for the same permission the first time it uses Selecta.',
    };
  } catch (err) {
    const code = err instanceof BridgeError ? err.errorCode : 'jxa_error';
    const message = err instanceof Error ? err.message : String(err);

    if (code === 'music_app_not_running') {
      return {
        step: 'music_app',
        status: 'missing',
        detail: message,
        fix: 'Open Music.app, then rerun setup.',
      };
    }

    if (code === 'automation_permission_denied') {
      return {
        step: 'music_app',
        status: 'missing',
        detail: message,
        fix: 'Allow Music under System Settings → Privacy & Security → Automation for this terminal, then rerun setup.',
      };
    }

    return {
      step: 'music_app',
      status: 'error',
      detail: message,
      fix: 'Open Music.app and rerun setup; if it fails again, rerun with SELECTA_DEBUG=1 for the full error.',
    };
  }
}

function checkLibrary(deps: SetupDeps): SetupStep {
  const status = readStatus(deps.dbPath);
  const tracks = status.cache?.track_count ?? 0;

  if (status.ok && tracks > 0) {
    return {
      step: 'library',
      status: 'ok',
      detail: `${tracks} tracks cached at ${deps.dbPath}.`,
    };
  }

  if (status.database.exists && !status.ok) {
    return {
      step: 'library',
      status: 'error',
      detail: `The cache at ${deps.dbPath} could not be read: ${status.database.errors.join('; ')}`,
      fix: `${deps.invocation} status reports the same check; move the file aside and run ${deps.invocation} refresh to rebuild it.`,
    };
  }

  return {
    step: 'library',
    status: 'missing',
    detail: status.database.exists
      ? `The cache at ${deps.dbPath} holds no tracks yet.`
      : `No library cache at ${deps.dbPath} yet.`,
    fix: `${deps.invocation} refresh`,
  };
}

/**
 * Plan every client change, apply them only when asked, and check the rest
 * read-only. The Music.app probe can raise the macOS Automation prompt, which
 * is the point of running it from a terminal the user is watching.
 */
export async function runSetup(
  deps: SetupDeps,
  { apply = false, clients = CLIENTS }: { apply?: boolean; clients?: readonly Client[] } = {},
): Promise<SetupReport> {
  const now = (deps.now ?? (() => new Date()))();
  const planners: Record<Client, () => Planned> = {
    desktop: () => planDesktop(deps, now),
    code: () => planCode(deps, now),
  };
  const steps: SetupStep[] = [];
  const requested: SetupStep[] = [];

  for (const client of CLIENTS) {
    if (!clients.includes(client)) {
      steps.push({
        step: client === 'desktop' ? 'claude_desktop' : 'claude_code',
        status: 'skipped',
        detail: 'Not requested (--client).',
      });
      continue;
    }

    const planned = planners[client]();
    const step = apply && planned.apply != null ? await planned.apply() : planned.step;

    steps.push(step);
    requested.push(step);
  }

  // A missing client is only a gap when no requested client could take Selecta.
  if (!requested.some((step) => ['ok', 'would_change', 'changed'].includes(step.status))) {
    for (const step of requested) {
      if (step.status !== 'skipped') continue;

      step.status = 'missing';
      step.fix = `Install it and rerun setup, or register another MCP client by hand: ${README}`;
    }
  }

  steps.push(await checkMetrognome(deps));
  steps.push(await checkMusicApp(deps));
  steps.push(checkLibrary(deps));

  return {
    ok: steps.every((step) => step.status !== 'missing' && step.status !== 'error'),
    dry_run: !apply,
    server: deps.server,
    steps,
  };
}
