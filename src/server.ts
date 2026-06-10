// MCP server wiring — the only file that knows MCP exists. Handlers stay plain
// functions (unit-testable without a transport); this file registers them and
// serializes their output-or-error-envelope as a JSON text block. Envelopes set
// isError so the model treats them as actionable failures, per docs/design.md.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './tools/common.js';
import { isSelectaError } from './tools/common.js';
import { handleSearch, searchInputShape, SEARCH_DESCRIPTION } from './tools/search.js';
import {
  handleGetTrackContext,
  getTrackContextInputShape,
  GET_TRACK_CONTEXT_DESCRIPTION,
} from './tools/get_track_context.js';
import {
  handleListPlaylists,
  listPlaylistsInputShape,
  LIST_PLAYLISTS_DESCRIPTION,
} from './tools/list_playlists.js';
import {
  handleRefreshLibrary,
  refreshLibraryInputShape,
  REFRESH_LIBRARY_DESCRIPTION,
} from './tools/refresh_library.js';

export const SERVER_INFO = { name: 'selecta', version: '0.1.0' };

function toToolResult(result: object) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    ...(isSelectaError(result) ? { isError: true } : {}),
  };
}

export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    'search',
    { description: SEARCH_DESCRIPTION, inputSchema: searchInputShape },
    async (args) => toToolResult(await handleSearch(args, deps)),
  );

  server.registerTool(
    'get_track_context',
    { description: GET_TRACK_CONTEXT_DESCRIPTION, inputSchema: getTrackContextInputShape },
    async (args) => toToolResult(await handleGetTrackContext(args, deps)),
  );

  server.registerTool(
    'list_playlists',
    { description: LIST_PLAYLISTS_DESCRIPTION, inputSchema: listPlaylistsInputShape },
    async (args) => toToolResult(await handleListPlaylists(args, deps)),
  );

  server.registerTool(
    'refresh_library',
    { description: REFRESH_LIBRARY_DESCRIPTION, inputSchema: refreshLibraryInputShape },
    async (args) => toToolResult(await handleRefreshLibrary(args, deps)),
  );

  return server;
}
