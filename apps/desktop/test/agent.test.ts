import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { AgentSessions } from '../src/host/agent.js';
import { ALLOWED_TOOLS, DENIED_TOOLS } from '../src/host/providers.js';
import type { AgentEvent } from '../src/shared/protocol.js';

const DRAFT = '11111111-2222-4333-8444-555555555555';

// Stands in for the claude CLI: records its argv, replays stream-json lines.
function fakeClaude() {
  const runs: { args: string[]; child: ReturnType<typeof child> }[] = [];

  function child() {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        proc.stdout.end();
        setImmediate(() => proc.emit('close', null));
      }),
      finish(lines: object[]) {
        for (const line of lines) proc.stdout.write(`${JSON.stringify(line)}\n`);

        proc.stdout.end();
        setImmediate(() => proc.emit('close', 0));
      },
    });

    return proc;
  }

  const spawn = vi.fn((_cmd: string, args: string[]) => {
    const proc = child();

    runs.push({ args, child: proc });

    return proc;
  });

  return { runs, spawn: spawn as never };
}

function sessions(spawn: never) {
  const events: AgentEvent[] = [];
  const agent = new AgentSessions({
    mcpEntry: '/repo/dist/index.js',
    emit: (_id, event, seq) => {
      expect(seq).toBe(events.length);
      events.push(event);
    },
    spawn,
  });

  return { agent, events };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

it('runs with no built-in tools and only the read and draft selecta tools', () => {
  const { runs, spawn } = fakeClaude();

  sessions(spawn).agent.start(DRAFT, 'warmup');

  const { args } = runs[0]!;

  expect(flag(args, '-p')).toContain(`Draft ID: ${DRAFT}`);
  expect(flag(args, '--tools')).toBe('');
  expect(flag(args, '--permission-mode')).toBe('dontAsk');
  expect(args).toContain('--strict-mcp-config');
  expect(JSON.parse(flag(args, '--mcp-config')!)).toMatchObject({
    mcpServers: { selecta: { env: { SELECTA_LOCAL_DRAFTS: '1' } } },
  });
  expect(args).toContain('mcp__selecta__edit_playlist_draft');
  expect(args.slice(args.indexOf('--disallowedTools'))).toContain(
    'mcp__selecta__save_playlist_draft',
  );
  expect(JSON.parse(flag(args, '--mcp-config')!).mcpServers.selecta.args).toEqual([
    '/repo/dist/index.js',
  ]);
});

it('resumes the session the first turn reported', async () => {
  const { runs, spawn } = fakeClaude();
  const { agent, events } = sessions(spawn);

  agent.start(DRAFT, 'warmup');
  expect(agent.history()[DRAFT]!.working).toBe(true);
  runs[0]!.child.finish([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Built it.' }] } },
    { type: 'result', subtype: 'success', session_id: 'S-1' },
  ]);
  await settle();
  expect(agent.history()[DRAFT]!.working).toBe(false);
  agent.send(DRAFT, 'less vocal', 'typed');

  expect(runs[0]!.args).toContain('--session-id');
  expect(flag(runs[1]!.args, '--resume')).toBe('S-1');
  expect(flag(runs[1]!.args, '-p')).toContain('get_playlist_draft');
  expect(events).toEqual([
    { kind: 'asked', text: 'warmup', brief: true, by: 'claude' },
    { kind: 'text', text: 'Built it.' },
    { kind: 'done', session_id: 'S-1' },
    { kind: 'asked', text: 'typed', by: 'claude' },
  ]);
  // The host's record is what a reloaded renderer replays.
  expect(agent.history()).toEqual({ [DRAFT]: { events, working: true } });
});

it('refuses a second run on a draft that is still working', () => {
  const { runs, spawn } = fakeClaude();
  const { agent, events } = sessions(spawn);

  agent.start(DRAFT, 'one');

  expect(() => agent.send(DRAFT, 'two')).toThrow('Claude is already working on this draft.');
  expect(runs).toHaveLength(1);
  expect(events).toEqual([{ kind: 'asked', text: 'one', brief: true, by: 'claude' }]);
});

it('records a refused request like any other outcome', () => {
  const { spawn } = fakeClaude();
  const { agent, events } = sessions(spawn);

  agent.refuse(DRAFT, 'go', 'Linked.', true);
  agent.refuse(DRAFT, 'more', 'Linked.');

  expect(events).toEqual([
    { kind: 'asked', text: 'go', brief: true },
    { kind: 'error', message: 'Linked.' },
    { kind: 'asked', text: 'more' },
    { kind: 'error', message: 'Linked.' },
  ]);
  expect(agent.history()[DRAFT]!.working).toBe(false);
});

it('reports a stop, a crash and a missing CLI as one error each', async () => {
  const { runs, spawn } = fakeClaude();
  const { agent, events } = sessions(spawn);

  agent.start(DRAFT, 'one');
  agent.cancel(DRAFT);
  await settle();

  agent.start(DRAFT, 'two');
  runs[1]!.child.stderr.write('Not logged in.');
  runs[1]!.child.finish([]);
  await settle();

  agent.start(DRAFT, 'three');
  runs[2]!.child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  runs[2]!.child.emit('close', -2);
  await settle();

  expect(events.filter((event) => event.kind !== 'asked')).toEqual([
    { kind: 'error', message: 'Stopped.' },
    { kind: 'error', message: 'Not logged in.' },
    {
      kind: 'error',
      message: 'Could not find the claude CLI. Install Claude Code, or set SELECTA_CLAUDE_PATH.',
    },
  ]);
});

it('never lists a tool as both allowed and denied', () => {
  expect(ALLOWED_TOOLS.filter((name) => DENIED_TOOLS.includes(name))).toEqual([]);
});

const codexArg = (args: string[], key: string) =>
  args.find((arg, i) => args[i - 1] === '-c' && arg.startsWith(`${key}=`))?.slice(key.length + 1);

it('runs codex read-only with its tools off and only the allowed selecta tools, auto-approved', () => {
  const { runs, spawn } = fakeClaude();

  sessions(spawn).agent.start(DRAFT, 'warmup', 'codex');

  const { args } = runs[0]!;

  expect(args.slice(0, 2)).toEqual(['exec', '--json']);
  expect(args).toContain('--ignore-user-config');
  expect(flag(args, '--sandbox')).toBe('read-only');
  expect(codexArg(args, 'features.shell_tool')).toBe('false');
  expect(codexArg(args, 'features.unified_exec')).toBe('false');
  expect(codexArg(args, 'web_search')).toBe('"disabled"');

  const server = codexArg(args, 'mcp_servers.selecta')!;

  expect(server).toContain(`enabled_tools=${JSON.stringify(ALLOWED_TOOLS)}`);
  expect(server).toContain('"save_playlist_draft"');
  expect(server).toContain('default_tools_approval_mode="approve"');
  expect(server).toContain('env={SELECTA_LOCAL_DRAFTS="1"}');
  expect(server).toContain('args=["/repo/dist/index.js"]');
  expect(args).not.toContain('resume');
  expect(args.at(-1)).toContain(`Draft ID: ${DRAFT}`);
});

it('resumes a codex thread, and starts fresh when the draft switches provider', async () => {
  const { runs, spawn } = fakeClaude();
  const { agent, events } = sessions(spawn);

  agent.start(DRAFT, 'warmup', 'codex');
  runs[0]!.child.finish([
    { type: 'thread.started', thread_id: 'T-1' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Built it.' } },
    { type: 'turn.completed', usage: {} },
  ]);
  await settle();
  agent.send(DRAFT, 'darker');
  runs[1]!.child.finish([{ type: 'thread.started', thread_id: 'T-1' }, { type: 'turn.completed' }]);
  await settle();
  agent.send(DRAFT, 'shorter', 'shorter', 'claude');

  expect(runs[1]!.args.slice(-3, -1)).toEqual(['resume', 'T-1']);
  expect(runs[2]!.args).toContain('--session-id');
  expect(runs[2]!.args).not.toContain('--resume');
  expect(events.filter((event) => event.kind === 'asked').map((event) => event.by)).toEqual([
    'codex',
    'codex',
    'claude',
  ]);
  expect(() => agent.send(DRAFT, 'again')).toThrow('Claude is already working on this draft.');
});

it('names the missing CLI for the provider that was asked for', async () => {
  const { runs, spawn } = fakeClaude();
  const { agent, events } = sessions(spawn);

  agent.start(DRAFT, 'one', 'codex');
  runs[0]!.child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
  await settle();

  expect(events.at(-1)).toEqual({
    kind: 'error',
    message: 'Could not find the codex CLI. Install Codex, or set SELECTA_CODEX_PATH.',
  });
});
