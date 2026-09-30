import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { AgentSessions, ALLOWED_TOOLS, DENIED_TOOLS } from '../src/host/agent.js';
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
    emit: (_id, event) => events.push(event),
    spawn,
  });

  return { agent, events };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

it('runs with no built-in tools and only the read and draft selecta tools', () => {
  const { runs, spawn } = fakeClaude();

  sessions(spawn).agent.start(DRAFT, 'warmup');

  const { args } = runs[0];

  expect(flag(args, '-p')).toContain(`Draft ID: ${DRAFT}`);
  expect(flag(args, '--tools')).toBe('');
  expect(flag(args, '--permission-mode')).toBe('dontAsk');
  expect(args).toContain('--strict-mcp-config');
  expect(args).toContain('mcp__selecta__edit_playlist_draft');
  expect(args.slice(args.indexOf('--disallowedTools'))).toContain(
    'mcp__selecta__save_playlist_draft',
  );
  expect(JSON.parse(flag(args, '--mcp-config')).mcpServers.selecta.args).toEqual([
    '/repo/dist/index.js',
  ]);
});

it('resumes the session the first turn reported', async () => {
  const { runs, spawn } = fakeClaude();
  const { agent, events } = sessions(spawn);

  agent.start(DRAFT, 'warmup');
  expect(agent.isRunning(DRAFT)).toBe(true);
  runs[0].child.finish([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Built it.' }] } },
    { type: 'result', subtype: 'success', session_id: 'S-1' },
  ]);
  await settle();
  expect(agent.isRunning(DRAFT)).toBe(false);
  agent.send(DRAFT, 'less vocal');

  expect(runs[0].args).toContain('--session-id');
  expect(flag(runs[1].args, '--resume')).toBe('S-1');
  expect(flag(runs[1].args, '-p')).toContain('get_playlist_draft');
  expect(events).toEqual([
    { kind: 'text', text: 'Built it.' },
    { kind: 'done', session_id: 'S-1' },
  ]);
});

it('refuses a second run on a draft that is still working', () => {
  const { runs, spawn } = fakeClaude();
  const { agent, events } = sessions(spawn);

  agent.start(DRAFT, 'one');
  agent.send(DRAFT, 'two');

  expect(runs).toHaveLength(1);
  expect(events).toEqual([{ kind: 'error', message: 'Claude is already working on this draft.' }]);
});

it('reports a stop, a crash and a missing CLI as one error each', async () => {
  const { runs, spawn } = fakeClaude();
  const { agent, events } = sessions(spawn);

  agent.start(DRAFT, 'one');
  agent.cancel(DRAFT);
  await settle();

  agent.start(DRAFT, 'two');
  runs[1].child.stderr.write('Not logged in.');
  runs[1].child.finish([]);
  await settle();

  agent.start(DRAFT, 'three');
  runs[2].child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  runs[2].child.emit('close', -2);
  await settle();

  expect(events).toEqual([
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
