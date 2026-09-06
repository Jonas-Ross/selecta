import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
const uri = 'ui://selecta-poc/tracks.html';
const tracks = [
  { id: 'fixture-1', title: 'Paper Moon', artist: 'Test Signals' },
  { id: 'fixture-2', title: 'Quiet Circuit', artist: 'Example Ensemble' },
  { id: 'fixture-3', title: 'Late Bus', artist: 'Sample Station' },
];
const server = new McpServer({ name: 'selecta-ui-poc', version: '0.0.1' });
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

registerAppTool(
  server,
  'show_fixture_tracks',
  {
    description:
      'Open a fixture-only interactive track picker. No Music.app access. Use a new draft label for each comparison. If UI is unavailable, show the returned tracks and ask the user for fixture IDs in text. Selection messages identify their draft; never assume an old card belongs to the newest draft.',
    inputSchema: { draft: z.string().min(1).max(80) },
    annotations,
    _meta: { ui: { resourceUri: uri } },
  },
  async ({ draft }) => ({
    content: [
      {
        type: 'text',
        text: `Fixture draft ${draft}. Select IDs in the card or reply in text. ${tracks.map((t) => `${t.id}: ${t.title} — ${t.artist}`).join('; ')}`,
      },
    ],
    structuredContent: { draft, tracks },
  }),
);
registerAppTool(
  server,
  'echo_fixture_selection',
  {
    description:
      'Read-only fixture callback. Echo known IDs and draft; controlled_error returns an intentional tool error. No writes or external I/O. Do not retry controlled errors.',
    inputSchema: {
      draft: z.string().min(1).max(80),
      ids: z.array(z.enum(['fixture-1', 'fixture-2', 'fixture-3'])).max(3),
      controlled_error: z.boolean().default(false),
    },
    annotations,
    _meta: { ui: { visibility: ['app', 'model'] } },
  },
  async ({ draft, ids, controlled_error }) => ({
    isError: controlled_error,
    content: [
      {
        type: 'text',
        text: controlled_error
          ? 'CONTROLLED_ERROR: fixture failure; nothing changed.'
          : JSON.stringify({ draft, ids }),
      },
    ],
  }),
);
registerAppResource(server, 'Fixture picker', uri, {}, async () => ({
  contents: [
    {
      uri,
      mimeType: RESOURCE_MIME_TYPE,
      text: await readFile(new URL('./dist/widget.html', import.meta.url), 'utf8'),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
    },
  ],
}));
await server.connect(new StdioServerTransport());
