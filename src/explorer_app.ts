import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import type { ToolDeps } from './tools/common.js';
import {
  explorerInputShape,
  EXPLORER_DESCRIPTION,
  handleLibraryExplorer,
} from './tools/library_explorer.js';

export const EXPLORER_RESOURCE = 'ui://selecta/library-explorer.html';

export function registerExplorerApp(
  server: McpServer,
  deps: ToolDeps,
  toToolResult: (result: object) => CallToolResult,
) {
  registerAppResource(server, 'Library explorer', EXPLORER_RESOURCE, {}, async () => ({
    contents: [
      {
        uri: EXPLORER_RESOURCE,
        mimeType: RESOURCE_MIME_TYPE,
        text: await readFile(new URL('./ui/library-explorer.html', import.meta.url), 'utf8'),
        _meta: { ui: { prefersBorder: true } },
      },
    ],
  }));
  registerAppTool(
    server,
    'show_library_explorer',
    {
      description: EXPLORER_DESCRIPTION,
      inputSchema: explorerInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: EXPLORER_RESOURCE } },
    },
    async (args) => toToolResult(await handleLibraryExplorer(args, deps)),
  );
}
