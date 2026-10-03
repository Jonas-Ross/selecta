// Every call the renderer can make, over the same core the MCP tools use.
// Drafts are the only thing the app writes locally; Save is the one Music.app
// write, and it goes through the same revision-checked operation as the tool.
import { z } from 'zod';
import type { ToolDeps } from '@selecta/core/tools/deps.js';
import { PlaylistDraftTools, getDraftInputShape } from '@selecta/core/tools/playlist_draft.js';
import type { DraftStore } from '@selecta/core/drafts/store.js';
import { BRIEF_LIMIT, type Method } from '../shared/protocol.js';
import { ARTWORK_GET_LIMIT } from '../shared/artwork.js';
import type { AgentSessions } from './agent.js';
import type { ArtworkCache } from './artwork.js';
import { crate } from './library.js';

const DraftId = z.strictObject(getDraftInputShape);
const Brief = z.strictObject({
  ...getDraftInputShape,
  brief: z.string().trim().min(1).max(BRIEF_LIMIT),
});
const Message = z.strictObject({
  ...getDraftInputShape,
  // Selected tracks ride along one line each, up to a draft's 500 entries.
  message: z.string().trim().min(1).max(60_000),
  // What the user typed, for the log; the message adds the selected tracks.
  text: z.string().max(60_000).optional(),
});
const Artwork = z.strictObject({
  track_ids: z.array(z.string().max(64)).max(ARTWORK_GET_LIMIT),
});

export function createApi(
  deps: ToolDeps & { drafts: () => DraftStore },
  agent: AgentSessions,
  artwork: ArtworkCache,
) {
  const drafts = new PlaylistDraftTools(deps);

  // The store refuses linked drafts atomically; this only fails a run before
  // it starts rather than partway through.
  function linked(draftId: string): boolean {
    const slot = deps.drafts().preview();

    return slot?.owner === draftId && slot.status !== 'inactive';
  }

  const LINKED =
    'This draft is linked to the Selecta Preview playlist in Music. Detach the preview where you started it to edit the draft here.';

  const handlers: Record<Method, (args: unknown) => unknown> = {
    'library.crate': (args) => crate(deps.cache(), args),
    'artwork.get': (args) => artwork.get(Artwork.parse(args).track_ids),
    'drafts.list': () => deps.drafts().list(),
    'drafts.get': (args) => drafts.get(args),
    'drafts.edit': (args) => drafts.edit(args),
    'drafts.save': (args) => drafts.save(args),
    'agent.start': (args) => {
      const { draft_id, brief } = Brief.parse(args);

      if (linked(draft_id)) agent.refuse(draft_id, brief, LINKED, true);
      else agent.start(draft_id, brief);
    },
    'agent.send': (args) => {
      const { draft_id, message, text } = Message.parse(args);

      if (linked(draft_id)) agent.refuse(draft_id, text ?? message, LINKED);
      else agent.send(draft_id, message, text);
    },
    'agent.cancel': (args) => agent.cancel(DraftId.parse(args).draft_id),
    'agent.history': () => agent.history(),
  };

  return async (method: string, args: unknown): Promise<unknown> => {
    if (!Object.hasOwn(handlers, method)) throw new Error(`Unknown method: ${method}`);

    return handlers[method as Method](args);
  };
}
