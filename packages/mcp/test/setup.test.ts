import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative as relativePath } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCliProgram } from '../src/cli.js';
import {
  codeConfigPath,
  desktopConfigPath,
  runSetup,
  serverEntry,
  runCommand,
  shellQuote,
  whichOnPath,
  type CommandResult,
  type SetupDeps,
  type SetupReport,
} from '../src/setup.js';
import { BridgeError } from '@selecta/core/types/errors.js';
import { SelectaCache } from '@selecta/core/cache/index.js';
import type { LibrarySnapshot } from '@selecta/core/types/bridge.js';
import library from '../../core/test/fixtures/library.json' with { type: 'json' };

const SERVER = { command: '/opt/homebrew/bin/node', args: ['/Users/x/selecta/dist/index.js'] };
const OK: CommandResult = { code: 0, stdout: '', stderr: '' };

type Fixture = { deps: SetupDeps; calls: string[][]; home: string };

function fixture(
  options: {
    desktop?: string | null;
    code?: unknown;
    claude?: boolean;
    run?: (command: string, args: string[]) => CommandResult;
  } = {},
): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'selecta-setup-'));
  const calls: string[][] = [];

  if (options.desktop !== null) {
    mkdirSync(dirname(desktopConfigPath(home)), { recursive: true });
    mkdirSync(join(home, 'Applications', 'Claude.app'), { recursive: true });

    if (options.desktop != null) writeFileSync(desktopConfigPath(home), options.desktop);
  }

  if (options.code !== undefined) {
    writeFileSync(codeConfigPath(home), JSON.stringify(options.code));
  }

  const deps: SetupDeps = {
    home,
    dbPath: join(home, 'Library', 'Application Support', 'Selecta', 'library.db'),
    server: SERVER,
    invocation: 'node dist/index.js',
    desktopApps: [join(home, 'Applications', 'Claude.app')],
    which: (name) =>
      name === 'claude' && options.claude !== false ? '/usr/local/bin/claude' : null,
    run: async (command, args) => {
      calls.push([command, ...args]);

      if (options.run) return options.run(command, args);

      return OK;
    },
    musicCheck: async () => {},
    metrognomeCheck: async () => ({ path: '/opt/homebrew/bin/metrognome', version: '0.1.0' }),
    now: () => new Date('2026-10-01T12:00:00Z'),
  };

  return { deps, calls, home };
}

const step = (report: { steps: { step: string }[] }, name: string): any =>
  report.steps.find((s) => s.step === name);

const mcpCalls = (calls: string[][]): string[][] => calls.filter((call) => call[1] === 'mcp');

describe('setup dry run', () => {
  it('reports what it would register and writes nothing', async () => {
    const original = '{"mcpServers":{"other":{"command":"x"}},"theme":"dark"}';
    const { deps, calls, home } = fixture({ desktop: original });

    const report = await runSetup(deps);

    expect(report.dry_run).toBe(true);
    expect(step(report, 'claude_desktop').status).toBe('would_change');
    expect(step(report, 'claude_code').status).toBe('would_change');
    expect(readFileSync(desktopConfigPath(home), 'utf8')).toBe(original);
    expect(readdirSync(dirname(desktopConfigPath(home)))).toEqual(['claude_desktop_config.json']);
    expect(mcpCalls(calls)).toEqual([]);
  });
});

describe('setup --apply', () => {
  it('adds selecta to Claude Desktop, keeping every other key, after a backup', async () => {
    const original = '{"mcpServers":{"other":{"command":"x"}},"theme":"dark"}';
    const { deps, home } = fixture({ desktop: original });

    const report = await runSetup(deps, { apply: true });
    const desktop = step(report, 'claude_desktop');

    expect(desktop.status).toBe('changed');
    expect(JSON.parse(readFileSync(desktopConfigPath(home), 'utf8'))).toEqual({
      mcpServers: { other: { command: 'x' }, selecta: SERVER },
      theme: 'dark',
    });
    expect(readFileSync(desktop.backup, 'utf8')).toBe(original);
  });

  it('writes through a symlinked Desktop config instead of replacing the link', async () => {
    const { deps, home } = fixture({ desktop: null });
    const managed = join(home, 'dotfiles', 'claude.json');

    mkdirSync(dirname(managed), { recursive: true });
    mkdirSync(dirname(desktopConfigPath(home)), { recursive: true });
    writeFileSync(managed, '{}');
    symlinkSync(managed, desktopConfigPath(home));

    await runSetup(deps, { apply: true });

    expect(lstatSync(desktopConfigPath(home)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(managed, 'utf8'))).toEqual({ mcpServers: { selecta: SERVER } });
  });

  it('refuses to replace a symlinked Desktop config whose target is gone', async () => {
    const { deps, home } = fixture({ desktop: null });

    mkdirSync(join(home, 'Applications', 'Claude.app'), { recursive: true });
    mkdirSync(dirname(desktopConfigPath(home)), { recursive: true });
    symlinkSync(join(home, 'gone.json'), desktopConfigPath(home));

    const desktop = step(await runSetup(deps, { apply: true }), 'claude_desktop');

    expect(desktop.status).toBe('error');
    expect(lstatSync(desktopConfigPath(home)).isSymbolicLink()).toBe(true);
  });

  it('creates the Desktop config when Claude Desktop has none yet, with no backup', async () => {
    const { deps, home } = fixture();

    const desktop = step(await runSetup(deps, { apply: true }), 'claude_desktop');

    expect(desktop).toMatchObject({ status: 'changed' });
    expect(desktop.backup).toBeUndefined();
    expect(JSON.parse(readFileSync(desktopConfigPath(home), 'utf8'))).toEqual({
      mcpServers: { selecta: SERVER },
    });
  });

  it('replaces a stale entry but keeps the env the user set on it', async () => {
    const stale = { command: 'node', args: ['/old/dist/index.js'], env: { SELECTA_DEBUG: '1' } };
    const { deps, home } = fixture({ desktop: JSON.stringify({ mcpServers: { selecta: stale } }) });

    const desktop = step(await runSetup(deps, { apply: true }), 'claude_desktop');

    expect(desktop.status).toBe('changed');
    // The entry can carry keys anywhere, so only the backup holds it.
    expect(JSON.stringify(desktop)).not.toContain('/old/dist/index.js');
    expect(JSON.parse(readFileSync(desktop.backup, 'utf8')).mcpServers.selecta).toEqual(stale);
    expect(JSON.parse(readFileSync(desktopConfigPath(home), 'utf8')).mcpServers.selecta).toEqual({
      ...SERVER,
      env: { SELECTA_DEBUG: '1' },
    });
  });

  it('registers with Claude Code through its own CLI', async () => {
    const { deps, calls } = fixture();

    await runSetup(deps, { apply: true });

    expect(mcpCalls(calls)).toEqual([
      [
        '/usr/local/bin/claude',
        'mcp',
        'add-json',
        '--scope',
        'user',
        'selecta',
        JSON.stringify({ type: 'stdio', ...SERVER }),
      ],
    ]);
  });

  it('removes a stale Claude Code entry first, saving it and carrying its env over', async () => {
    const stale = { type: 'stdio', command: 'node', args: ['/old.js'], env: { A: 'b' } };
    const { deps, calls } = fixture({ code: { mcpServers: { selecta: stale } } });

    const code = step(await runSetup(deps, { apply: true }), 'claude_code');

    expect(code.status).toBe('changed');
    expect(JSON.parse(readFileSync(code.backup, 'utf8'))).toEqual({ selecta: stale });
    expect(statSync(code.backup).mode & 0o777).toBe(0o600);
    expect(mcpCalls(calls)).toEqual([
      ['/usr/local/bin/claude', 'mcp', 'remove', '--scope', 'user', 'selecta'],
      [
        '/usr/local/bin/claude',
        'mcp',
        'add-json',
        '--scope',
        'user',
        'selecta',
        JSON.stringify({ ...stale, ...SERVER }),
      ],
    ]);
  });

  it('turns an old remote entry into a stdio one, keeping only its env', async () => {
    const remote = { type: 'http', url: 'https://example.test/mcp', env: { A: 'b' } };
    const { deps, calls, home } = fixture({
      desktop: JSON.stringify({ mcpServers: { selecta: { ...remote, headers: { X: 'y' } } } }),
      code: { mcpServers: { selecta: remote } },
    });

    await runSetup(deps, { apply: true });

    expect(JSON.parse(readFileSync(desktopConfigPath(home), 'utf8')).mcpServers.selecta).toEqual({
      ...SERVER,
      env: { A: 'b' },
    });
    expect(mcpCalls(calls).at(-1)?.at(-1)).toBe(
      JSON.stringify({ type: 'stdio', ...SERVER, env: { A: 'b' } }),
    );
  });

  it('re-registers an entry with the right command but a remote transport', async () => {
    const { deps } = fixture({
      desktop: JSON.stringify({ mcpServers: { selecta: { type: 'sse', url: 'x', ...SERVER } } }),
    });

    expect(step(await runSetup(deps), 'claude_desktop').status).toBe('would_change');
  });

  it('leaves client entries alone when a hand-given metrognome fails the check', async () => {
    const working = { ...SERVER, env: { SELECTA_METROGNOME_PATH: '/opt/mg/metrognome' } };
    const original = JSON.stringify({ mcpServers: { selecta: working } });
    const { deps, home, calls } = fixture({
      desktop: original,
      code: { mcpServers: { selecta: { type: 'stdio', ...working } } },
    });

    deps.server = { ...SERVER, env: { SELECTA_METROGNOME_PATH: '/nope/metrognome' } };

    deps.metrognomeCheck = async () => {
      throw new Error('metrognome not found.');
    };

    const report = await runSetup(deps, { apply: true });

    expect(step(report, 'claude_desktop').status).toBe('skipped');
    expect(step(report, 'claude_code').status).toBe('skipped');
    expect(step(report, 'metrognome')).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('/nope/metrognome'),
    });
    expect(report.ok).toBe(false);
    expect(readFileSync(desktopConfigPath(home), 'utf8')).toBe(original);
    expect(mcpCalls(calls)).toEqual([]);
  });

  it('pins a hand-given metrognome path into the entry, keeping the user env', async () => {
    const pin = { SELECTA_METROGNOME_PATH: '/opt/mg/metrognome' };
    const { deps, home } = fixture({
      desktop: JSON.stringify({ mcpServers: { selecta: { ...SERVER, env: { A: 'b' } } } }),
    });

    deps.server = { ...SERVER, env: pin };

    expect(step(await runSetup(deps, { apply: true }), 'claude_desktop').status).toBe('changed');
    expect(
      JSON.parse(readFileSync(desktopConfigPath(home), 'utf8')).mcpServers.selecta.env,
    ).toEqual({ A: 'b', ...pin });
    expect(step(await runSetup(deps), 'claude_desktop').status).toBe('ok');
  });

  it('drops a kept metrognome pin when run without one, since it was not checked', async () => {
    const { deps, home } = fixture({
      desktop: JSON.stringify({
        mcpServers: { selecta: { ...SERVER, env: { A: 'b', SELECTA_METROGNOME_PATH: '/old/mg' } } },
      }),
    });

    expect(step(await runSetup(deps), 'claude_desktop').status).toBe('would_change');
    expect(step(await runSetup(deps, { apply: true }), 'claude_desktop').status).toBe('changed');
    expect(
      JSON.parse(readFileSync(desktopConfigPath(home), 'utf8')).mcpServers.selecta.env,
    ).toEqual({ A: 'b' });
    expect(step(await runSetup(deps), 'claude_desktop').status).toBe('ok');
  });

  it('reports a failed `claude mcp add` instead of claiming success', async () => {
    const { deps } = fixture({
      run: () => ({ code: 1, stdout: '', stderr: 'boom' }),
    });

    const report = await runSetup(deps, { apply: true });

    expect(step(report, 'claude_code')).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('boom'),
    });
    expect(report.ok).toBe(false);
  });

  it('puts the old Claude Code entry back when the replacement fails', async () => {
    const stale = { type: 'stdio', command: 'node', args: ['/old.js'] };
    const { deps, calls } = fixture({
      code: { mcpServers: { selecta: stale } },
      // The replacement add fails; the restore after it succeeds.
      run: (_command, args) =>
        args[1] === 'add-json' && args.at(-1) !== JSON.stringify(stale)
          ? { code: 1, stdout: '', stderr: 'boom' }
          : OK,
    });

    const code = step(await runSetup(deps, { apply: true }), 'claude_code');

    expect(code).toMatchObject({ status: 'error', detail: expect.stringContaining('restored') });
    expect(mcpCalls(calls).at(-1)).toEqual([
      '/usr/local/bin/claude',
      'mcp',
      'add-json',
      '--scope',
      'user',
      'selecta',
      JSON.stringify(stale),
    ]);
  });

  it('configures a Claude Desktop that is installed but never launched', async () => {
    const { deps, home } = fixture({ desktop: null });

    mkdirSync(join(home, 'Applications', 'Claude.app'), { recursive: true });

    expect(step(await runSetup(deps, { apply: true }), 'claude_desktop').status).toBe('changed');
    expect(JSON.parse(readFileSync(desktopConfigPath(home), 'utf8'))).toEqual({
      mcpServers: { selecta: SERVER },
    });
  });

  it('is idempotent: a second run finds everything registered and touches nothing', async () => {
    const { deps, calls, home } = fixture({ desktop: '{}' });

    await runSetup(deps, { apply: true });
    writeFileSync(
      codeConfigPath(home),
      JSON.stringify({ mcpServers: { selecta: { type: 'stdio', ...SERVER, env: {} } } }),
    );
    const before = readdirSync(dirname(desktopConfigPath(home)));

    calls.length = 0;

    const report = await runSetup(deps, { apply: true });

    expect(step(report, 'claude_desktop').status).toBe('ok');
    expect(step(report, 'claude_code').status).toBe('ok');
    expect(readdirSync(dirname(desktopConfigPath(home)))).toEqual(before);
    expect(mcpCalls(calls)).toEqual([]);
  });
});

describe('setup refuses what it cannot read', () => {
  it('leaves an unparseable Desktop config alone', async () => {
    const { deps, home } = fixture({ desktop: '{ not json' });

    const report = await runSetup(deps, { apply: true });

    expect(step(report, 'claude_desktop').status).toBe('error');
    expect(readFileSync(desktopConfigPath(home), 'utf8')).toBe('{ not json');
    expect(report.ok).toBe(false);
  });

  it('leaves a config whose mcpServers is not an object alone', async () => {
    const { deps, home } = fixture({ desktop: '{"mcpServers":[]}' });

    expect(step(await runSetup(deps, { apply: true }), 'claude_desktop').status).toBe('error');
    expect(readFileSync(desktopConfigPath(home), 'utf8')).toBe('{"mcpServers":[]}');
  });
});

describe('setup says what is missing', () => {
  it('flags the clients as missing when neither is installed', async () => {
    const { deps } = fixture({ desktop: null, claude: false });

    const report = await runSetup(deps);

    expect(step(report, 'claude_desktop').status).toBe('missing');
    expect(step(report, 'claude_code').status).toBe('missing');
    expect(report.ok).toBe(false);
  });

  it('does not count a support folder an uninstall left behind as Claude Desktop', async () => {
    const { deps, home } = fixture({ desktop: null, claude: false });

    mkdirSync(dirname(desktopConfigPath(home)), { recursive: true });

    const report = await runSetup(deps, { apply: true });

    expect(step(report, 'claude_desktop').status).toBe('missing');
    expect(report.ok).toBe(false);
  });

  it('skips an absent client quietly when the other one is there', async () => {
    const { deps } = fixture({ claude: false });

    const report = await runSetup(deps);

    expect(step(report, 'claude_code').status).toBe('skipped');
  });

  it('leaves out a client not asked for', async () => {
    const { deps, calls } = fixture();

    const report = await runSetup(deps, { apply: true, clients: ['desktop'] });

    expect(step(report, 'claude_code').status).toBe('skipped');
    expect(mcpCalls(calls)).toEqual([]);
  });

  it('names the fix for a missing metrognome, Automation denial and an empty cache', async () => {
    const { deps } = fixture();

    deps.metrognomeCheck = async () => {
      throw new BridgeError('enrichment_error', 'metrognome was not found on PATH.');
    };

    deps.musicCheck = async () => {
      throw new BridgeError(
        'automation_permission_denied',
        'Not authorized to send Apple events to Music.',
      );
    };

    const report = await runSetup(deps);

    expect(step(report, 'metrognome')).toMatchObject({
      status: 'unavailable',
      detail: expect.stringContaining('was not found'),
      fix: expect.stringContaining('brew install jonas-ross/tap/metrognome'),
    });
    expect(step(report, 'music_app')).toMatchObject({
      status: 'missing',
      fix: expect.stringContaining('Automation'),
    });
    expect(step(report, 'library')).toMatchObject({
      status: 'missing',
      fix: 'node dist/index.js refresh',
    });
    expect(report.ok).toBe(false);
  });

  it('reports an unreadable cache as an error, not as an empty library', async () => {
    const { deps } = fixture();

    mkdirSync(dirname(deps.dbPath), { recursive: true });
    writeFileSync(deps.dbPath, 'not a database');

    expect(step(await runSetup(deps), 'library')).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('could not be read'),
    });
  });

  it('treats a missing metrognome as optional, not as a failed setup', async () => {
    const { deps, home } = fixture({ desktop: '{}' });

    deps.metrognomeCheck = async () => {
      throw new BridgeError('enrichment_error', 'metrognome was not found on PATH.');
    };

    await runSetup(deps, { apply: true });
    writeFileSync(codeConfigPath(home), JSON.stringify({ mcpServers: { selecta: SERVER } }));
    const cache = SelectaCache.open(deps.dbPath);

    cache.refreshFromSnapshot(library as LibrarySnapshot, { durationMs: 1 });
    cache.close();

    const report = await runSetup(deps);

    expect(step(report, 'metrognome').status).toBe('unavailable');
    expect(report.ok).toBe(true);
  });

  it('keeps checking after a client refuses the write', async () => {
    const { deps, home } = fixture({ desktop: '{}' });

    // A directory where the temp file goes makes the write fail.
    mkdirSync(`${desktopConfigPath(home)}.selecta-${process.pid}.tmp`);

    const report = await runSetup(deps, { apply: true });

    expect(step(report, 'claude_desktop')).toMatchObject({ status: 'error' });
    expect(step(report, 'claude_code').status).toBe('changed');
    expect(step(report, 'library')).toBeDefined();
  });

  it('reports the metrognome version it found', async () => {
    const { deps } = fixture();

    expect(step(await runSetup(deps), 'metrognome')).toMatchObject({
      status: 'ok',
      detail: 'metrognome 0.1.0 at /opt/homebrew/bin/metrognome.',
    });
  });
});

describe('runCommand', () => {
  it('reports a spawn failure without echoing the arguments', async () => {
    // Killed by a signal: Node's message for this repeats the full command line.
    const result = await runCommand('/bin/sh', ['-c', 'kill -9 $$', '{"env":{"KEY":"secret"}}']);

    expect(result).toMatchObject({ code: null, stderr: 'killed by SIGKILL' });
  });
});

describe('shellQuote', () => {
  it('leaves a plain path alone and quotes one the shell would split', () => {
    expect(shellQuote('dist/index.js')).toBe('dist/index.js');
    expect(shellQuote("/Users/x/my repo/it's/dist/index.js")).toBe(
      "'/Users/x/my repo/it'\\''s/dist/index.js'",
    );
  });
});

describe('whichOnPath', () => {
  it('ignores relative PATH entries, which a client would resolve somewhere else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'selecta-which-'));

    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'node'), '', { mode: 0o755 });
    const cwd = process.cwd();

    process.chdir(dir);

    try {
      expect(whichOnPath('node', 'bin')).toBeNull();
      expect(whichOnPath('node', join(dir, 'bin'))).toBe(join(dir, 'bin', 'node'));
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('serverEntry', () => {
  it('prefers the linked node over the versioned path behind it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'selecta-node-'));
    const real = join(dir, 'node-22.1');

    writeFileSync(real, '');

    expect(serverEntry('/x/dist/index.js', real, () => real).command).toBe(real);
    expect(serverEntry('/x/dist/index.js', real, () => '/elsewhere/node').command).toBe(real);
    expect(serverEntry('/x/dist/index.js', real, () => null)).toEqual({
      command: real,
      args: ['/x/dist/index.js'],
    });
  });
});

describe('selecta setup CLI', () => {
  it('prints one JSON report, narrates on stderr and exits 1 while something is missing', async () => {
    const { deps } = fixture();
    const stdout: string[] = [];
    const info = vi.fn();
    const setExitCode = vi.fn();

    await createCliProgram({
      dbPath: deps.dbPath,
      logger: { info, debug: vi.fn(), error: vi.fn() },
      setExitCode,
      writeStdout: (text) => stdout.push(text),
      setup: deps,
    }).parseAsync(['node', 'selecta', 'setup']);

    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ dry_run: true, server: SERVER });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Re-run with --apply'));
    // No cache yet in the fixture home.
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it('checks and pins the same absolute metrognome path it was given', async () => {
    const { deps, home } = fixture();
    const { server: _, metrognomeCheck: __, ...rest } = deps;
    const binary = join(home, 'metrognome');

    writeFileSync(binary, '#!/bin/sh\necho "metrognome 0.1.0"\n', { mode: 0o755 });

    const run = async (path: string) => {
      const stdout: string[] = [];

      await createCliProgram({
        dbPath: deps.dbPath,
        logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
        setExitCode: vi.fn(),
        writeStdout: (text) => stdout.push(text),
        setup: rest,
      }).parseAsync(['node', 'selecta', 'setup', '--metrognome-path', path]);

      return JSON.parse(stdout[0]!) as SetupReport;
    };

    const relative = await run(relativePath(process.cwd(), binary));

    expect(relative.server.env).toEqual({ SELECTA_METROGNOME_PATH: binary });
    expect(step(relative, 'metrognome').status).toBe('ok');

    // A bare name is a path relative to here, not a PATH lookup.
    vi.stubEnv('PATH', home);
    const bare = await run('metrognome').finally(() => vi.unstubAllEnvs());

    expect(step(bare, 'metrognome').status).toBe('error');
    expect(step(bare, 'claude_desktop').status).toBe('skipped');
  });
});
