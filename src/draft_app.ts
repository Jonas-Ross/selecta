// Additive MCP Apps registration: the widget resource and the tools whose
// results render in it. The plain draft tools register in server.ts.
import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { Appearance } from './drafts/store.js';
import {
  type PlaylistDraftTools,
  showDraftInputShape,
  SHOW_DRAFT_DESCRIPTION,
} from './tools/playlist_draft.js';

export const DRAFT_RESOURCE = 'ui://selecta/playlist-draft.html';

export function registerDraftApp(
  server: McpServer,
  handlers: PlaylistDraftTools,
  toToolResult: (result: object) => CallToolResult,
) {
  registerAppResource(server, 'Playlist draft', DRAFT_RESOURCE, {}, async () => ({
    contents: [
      {
        uri: DRAFT_RESOURCE,
        mimeType: RESOURCE_MIME_TYPE,
        text: await readFile(new URL('./ui/playlist-draft.html', import.meta.url), 'utf8'),
        _meta: { ui: { prefersBorder: true } },
      },
    ],
  }));
  registerAppTool(
    server,
    'playlist_draft_appearance',
    {
      description:
        'Read or set the local card appearance preference. Independent of draft content and revisions. No Music.app call.',
      inputSchema: { appearance: Appearance.optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: DRAFT_RESOURCE, visibility: ['app'] } },
    },
    async (args) => toToolResult(handlers.appearance(args)),
  );
  registerAppTool(
    server,
    'show_playlist_draft',
    {
      description: SHOW_DRAFT_DESCRIPTION,
      inputSchema: showDraftInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: DRAFT_RESOURCE } },
    },
    async (args) => toToolResult(await handlers.show(args)),
  );
}
