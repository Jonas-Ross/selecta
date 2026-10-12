// The other end of the PATH shims in bin/.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { MusicSim } from './music.js';

export type Turn = {
  provider: 'claude' | 'codex';
  prompt: string;
  draftId: string;
  resumed: boolean;
  call: (tool: string, args: object) => Promise<any>;
  say: (text: string) => void;
};

export type ClaudeScript = (turn: Turn) => Promise<void>;

type Server = { command: string; args: string[]; env?: object };
type Config = { mcpServers: { selecta: Server } };

/** What one run was asked, read from either CLI's flags. */
type Run = {
  prompt: string;
  session: string;
  resumed: boolean;
  allowed: (tool: string) => boolean;
  selecta: Server;
};

/** How a run's events reach stdout in that CLI's own stream format. */
type Stream = {
  say: (text: string) => void;
  tool: (tool: string, input: object) => void;
  done: (session: string, denied: string[]) => void;
  failed: (message: string) => void;
};

export async function startSim(options: { music: MusicSim; claude: ClaudeScript; home: string }) {
  const server = createServer(async (request, response) => {
    let body = '';

    for await (const chunk of request) body += chunk;

    if (request.url === '/osascript') {
      try {
        response.end(JSON.stringify({ stdout: options.music.run(body) }));
      } catch (error) {
        response.end(JSON.stringify({ stderr: (error as Error).message }));
      }
    } else if (request.url === '/claude' || request.url === '/codex') {
      const line = (data: object) => response.write(`${JSON.stringify(data)}\n`);
      const args = JSON.parse(body) as string[];
      const [run, stream] =
        request.url === '/claude' ? [claudeRun(args), claudeStream(line)] : codexRun(args, line);

      await runAgent(request.url === '/claude' ? 'claude' : 'codex', run, stream, options).catch(
        (error: Error) => stream.failed(error.message),
      );
      response.end();
    } else response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function claudeRun(args: string[]): Run {
  const flag = (name: string) => args[args.indexOf(name) + 1] ?? '';
  const list = (name: string) => {
    const start = args.indexOf(name) + 1;
    const end = args.findIndex((arg, i) => i >= start && arg.startsWith('--'));

    return args.slice(start, end === -1 ? undefined : end);
  };
  const allowed = new Set(list('--allowedTools'));
  const denied = new Set(list('--disallowedTools'));

  return {
    prompt: flag('-p'),
    session: args.includes('--resume') ? flag('--resume') : flag('--session-id'),
    resumed: args.includes('--resume'),
    allowed: (tool) => allowed.has(`mcp__selecta__${tool}`) && !denied.has(`mcp__selecta__${tool}`),
    selecta: (JSON.parse(flag('--mcp-config')) as Config).mcpServers.selecta,
  };
}

const claudeStream = (line: (data: object) => void): Stream => ({
  say: (text) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
  tool: (tool, input) =>
    line({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: `mcp__selecta__${tool}`, input }] },
    }),
  done: (session, denied) =>
    line({
      type: 'result',
      subtype: 'success',
      session_id: session,
      permission_denials: denied.map((tool) => ({ tool_name: `mcp__selecta__${tool}` })),
    }),
  failed: (message) =>
    line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: message }),
});

// The selecta server rides in one `-c mcp_servers.selecta={...}` whose values are JSON literals.
function codexRun(args: string[], line: (data: object) => void): [Run, Stream] {
  const server = args.find((arg) => arg.startsWith('mcp_servers.selecta='))!;
  const value = (key: string) =>
    JSON.parse(new RegExp(`${key}=(".*?"|\\[.*?\\])`).exec(server)![1]!);
  const env = Object.fromEntries(
    [...(/env=\{(.*?)\}/.exec(server)?.[1] ?? '').matchAll(/(\w+)=("(?:[^"\\]|\\.)*")/g)].map(
      ([, key, json]) => [key, JSON.parse(json!)],
    ),
  );
  const enabled = new Set<string>(value('enabled_tools'));
  const disabled = new Set<string>(value('disabled_tools'));
  const resumeAt = args.indexOf('resume');
  const session =
    resumeAt === -1 ? `T-${Math.random().toString(36).slice(2)}` : args[resumeAt + 1]!;

  line({ type: 'thread.started', thread_id: session });

  return [
    {
      prompt: args.at(-1)!,
      session,
      resumed: resumeAt !== -1,
      allowed: (tool) => enabled.has(tool) && !disabled.has(tool),
      selecta: { command: value('command'), args: value('args'), env },
    },
    {
      say: (text) => line({ type: 'item.completed', item: { type: 'agent_message', text } }),
      tool: (tool) => line({ type: 'item.started', item: { type: 'mcp_tool_call', tool } }),
      done: () => line({ type: 'turn.completed', usage: {} }),
      failed: (message) => line({ type: 'turn.failed', error: { message } }),
    },
  ];
}

async function runAgent(
  provider: Turn['provider'],
  run: Run,
  stream: Stream,
  options: { claude: ClaudeScript; home: string },
) {
  const transport = new StdioClientTransport({
    command: run.selecta.command,
    args: run.selecta.args,
    env: { ...(process.env as Record<string, string>), HOME: options.home, ...run.selecta.env },
    stderr: 'ignore',
  });
  const client = new Client({ name: `fake-${provider}`, version: '0.0.0' });
  const denials: string[] = [];

  await client.connect(transport);

  try {
    await options.claude({
      provider,
      prompt: run.prompt,
      draftId: /Draft ID: (\S+)/.exec(run.prompt)?.[1] ?? '',
      resumed: run.resumed,
      say: stream.say,
      call: async (tool, input) => {
        stream.tool(tool, input);

        if (!run.allowed(tool)) {
          denials.push(tool);
          throw new Error(`${tool} is not allowed for the in-app agent.`);
        }

        const result = await client.callTool({
          name: tool,
          arguments: input as Record<string, unknown>,
        });

        const [first] = result.content as { type: string; text?: string }[];

        return result.structuredContent ?? JSON.parse(first?.text ?? 'null');
      },
    });
    stream.done(run.session, denials);
  } finally {
    await client.close();
  }
}
