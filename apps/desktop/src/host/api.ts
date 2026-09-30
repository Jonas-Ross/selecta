// Every call the renderer can make, over the same core the MCP tools use.
// Drafts are the only thing the app writes locally; Save is the one Music.app
// write, and it goes through the same revision-checked operation as the tool.
import { z } from 'zod';
import type { ToolDeps } from '@selecta/core/tools/deps.js';
import { PlaylistDraftTools, getDraftInputShape } from '@selecta/core/tools/playlist_draft.js';
import type { DraftStore } from '@selecta/core/drafts/store.js';
import type { Method } from '../shared/protocol.js';
import type { AgentSessions } from './agent.js';

const DraftId = z.strictObject(getDraftInputShape);
const Brief = z.strictObject({ ...getDraftInputShape, brief: z.string().trim().min(1).max(4000) });
const Message = z.strictObject({
  ...getDraftInputShape,
  // Selected tracks ride along one line each, up to a draft's 500 entries.
  message: z.string().trim().min(1).max(60_000),
});

export function createApi(deps: ToolDeps & { drafts: () => DraftStore }, agent: AgentSessions) {
  const drafts = new PlaylistDraftTools(deps);

  // The store refuses linked drafts atomically; this only fails a run before
  // it starts rather than partway through.
  function localOnly(draftId: string): string {
    const slot = deps.drafts().preview();

    if (slot?.owner === draftId && slot.status !== 'inactive')
      throw new Error(
        'This draft is linked to the Selecta Preview playlist in Music. Detach the preview where you started it to edit the draft here.',
      );

    return draftId;
  }

  const handlers: Record<Method, (args: unknown) => unknown> = {
    'drafts.list': () => deps.drafts().list(),
    'drafts.get': (args) => drafts.get(args),
    'drafts.edit': (args) => drafts.edit(args),
    'drafts.save': (args) => drafts.save(args),
    'agent.start': (args) => {
      const { draft_id, brief } = Brief.parse(args);

      agent.start(localOnly(draft_id), brief);
    },
    'agent.send': (args) => {
      const { draft_id, message } = Message.parse(args);

      agent.send(localOnly(draft_id), message);
    },
    'agent.cancel': (args) => agent.cancel(DraftId.parse(args).draft_id),
  };

  return async (method: string, args: unknown): Promise<unknown> => {
    if (!Object.hasOwn(handlers, method)) throw new Error(`Unknown method: ${method}`);

    return handlers[method as Method](args);
  };
}
