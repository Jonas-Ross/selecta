// MCP server wiring — the only file that knows MCP exists. Handlers stay plain
// functions (unit-testable without a transport); this file registers them and
// serializes their output-or-error-envelope as a JSON text block. Envelopes set
// isError so the model treats them as actionable failures (docs/contracts.md §2).

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
import {
  handleCreatePlaylist,
  createPlaylistInputShape,
  CREATE_PLAYLIST_DESCRIPTION,
} from './tools/create_playlist.js';
import {
  handlePreviewPlaylist,
  previewPlaylistInputShape,
  PREVIEW_PLAYLIST_DESCRIPTION,
} from './tools/preview_playlist.js';
import { handleAddTracks, addTracksInputShape, ADD_TRACKS_DESCRIPTION } from './tools/add_tracks.js';
import {
  handleRemoveTracks,
  removeTracksInputShape,
  REMOVE_TRACKS_DESCRIPTION,
} from './tools/remove_tracks.js';
import {
  handleLibraryOverview,
  libraryOverviewInputShape,
  LIBRARY_OVERVIEW_DESCRIPTION,
} from './tools/library_overview.js';

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
    'library_overview',
    { description: LIBRARY_OVERVIEW_DESCRIPTION, inputSchema: libraryOverviewInputShape },
    async (args) => toToolResult(await handleLibraryOverview(args, deps)),
  );

  server.registerTool(
    'refresh_library',
    { description: REFRESH_LIBRARY_DESCRIPTION, inputSchema: refreshLibraryInputShape },
    async (args) => toToolResult(await handleRefreshLibrary(args, deps)),
  );

  server.registerTool(
    'create_playlist',
    { description: CREATE_PLAYLIST_DESCRIPTION, inputSchema: createPlaylistInputShape },
    async (args) => toToolResult(await handleCreatePlaylist(args, deps)),
  );

  server.registerTool(
    'preview_playlist',
    { description: PREVIEW_PLAYLIST_DESCRIPTION, inputSchema: previewPlaylistInputShape },
    async (args) => toToolResult(await handlePreviewPlaylist(args, deps)),
  );

  server.registerTool(
    'add_tracks',
    { description: ADD_TRACKS_DESCRIPTION, inputSchema: addTracksInputShape },
    async (args) => toToolResult(await handleAddTracks(args, deps)),
  );

  server.registerTool(
    'remove_tracks',
    { description: REMOVE_TRACKS_DESCRIPTION, inputSchema: removeTracksInputShape },
    async (args) => toToolResult(await handleRemoveTracks(args, deps)),
  );

  return server;
}
