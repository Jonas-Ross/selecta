// The other end of the PATH shims in bin/.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { MusicSim } from './music.js';

export type Turn = {
  prompt: string;
  draftId: string;
  resumed: boolean;
  call: (tool: string, args: object) => Promise<any>;
  say: (text: string) => void;
};

export type ClaudeScript = (turn: Turn) => Promise<void>;

type Config = { mcpServers: { selecta: { command: string; args: string[]; env?: object } } };

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
    } else if (request.url === '/claude') {
      const line = (data: object) => response.write(`${JSON.stringify(data)}\n`);

      await runClaude(JSON.parse(body) as string[], options, line).catch((error: Error) =>
        line({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: error.message,
        }),
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

async function runClaude(
  args: string[],
  options: { claude: ClaudeScript; home: string },
  line: (data: object) => void,
) {
  const flag = (name: string) => args[args.indexOf(name) + 1];
  const list = (name: string) => {
    const start = args.indexOf(name) + 1;
    const end = args.findIndex((arg, i) => i >= start && arg.startsWith('--'));

    return args.slice(start, end === -1 ? undefined : end);
  };
  const prompt = flag('-p');
  const allowed = new Set(list('--allowedTools'));
  const denied = new Set(list('--disallowedTools'));
  const session = args.includes('--resume') ? flag('--resume') : flag('--session-id');
  const { selecta } = (JSON.parse(flag('--mcp-config')) as Config).mcpServers;
  const transport = new StdioClientTransport({
    command: selecta.command,
    args: selecta.args,
    env: { ...(process.env as Record<string, string>), HOME: options.home, ...selecta.env },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'fake-claude', version: '0.0.0' });
  const denials: { tool_name: string }[] = [];

  await client.connect(transport);

  try {
    await options.claude({
      prompt,
      draftId: /Draft ID: (\S+)/.exec(prompt)?.[1] ?? '',
      resumed: args.includes('--resume'),
      say: (text) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
      call: async (tool, input) => {
        const name = `mcp__selecta__${tool}`;

        line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

        if (denied.has(name) || !allowed.has(name)) {
          denials.push({ tool_name: name });
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
    line({ type: 'result', subtype: 'success', session_id: session, permission_denials: denials });
  } finally {
    await client.close();
  }
}
