// Additive MCP Apps registration. Core draft handlers remain transport-neutral.
import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import type { ToolDeps } from './tools/common.js';
import { isSelectaError } from './tools/common.js';
import type { DraftStore } from './drafts/store.js';
import {
  PlaylistDraftTools,
  showDraftInputShape,
  getDraftInputShape,
  editDraftInputShape,
  revisionInputShape,
  SHOW_DRAFT_DESCRIPTION,
  EDIT_DRAFT_DESCRIPTION,
  SAVE_DRAFT_DESCRIPTION,
} from './tools/playlist_draft.js';

export const DRAFT_RESOURCE = 'ui://selecta/playlist-draft.html';

export function registerDraftApp(server: McpServer, deps: ToolDeps, store?: DraftStore) {
  const handlers = new PlaylistDraftTools(deps, store);
  const result = (value: object) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: { ...value },
    ...(isSelectaError(value) ? { isError: true } : {}),
  });

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
    'show_playlist_draft',
    {
      description: SHOW_DRAFT_DESCRIPTION,
      inputSchema: showDraftInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: DRAFT_RESOURCE } },
    },
    async (args) => result(await handlers.show(args)),
  );
  server.registerTool(
    'get_playlist_draft',
    {
      description:
        'Read-only recovery of a local draft by draft_id, including latest revision, edits, selection, pins, feedback and save outcome. No Music.app call or draft mutation. Missing tracks return inspection_error alongside the recoverable draft. Missing drafts return a recovery hint.',
      inputSchema: getDraftInputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => result(await handlers.get(args)),
  );
  server.registerTool(
    'edit_playlist_draft',
    {
      description: EDIT_DRAFT_DESCRIPTION,
      inputSchema: editDraftInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => result(await handlers.edit(args)),
  );
  server.registerTool(
    'save_playlist_draft',
    {
      description: SAVE_DRAFT_DESCRIPTION,
      inputSchema: revisionInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => result(await handlers.save(args)),
  );
}
