// Every call the renderer can make, over the same core the MCP tools use.
// Drafts are the only thing the app writes locally. Music.app gets two kinds of
// write, both through the operations the MCP tools use: Save, and the Selecta
// Preview playlist that Listen plays from, kept in step with a linked draft.
import { z } from 'zod';
import type { ToolDeps } from '@selecta/core/tools/deps.js';
import {
  PlaylistDraftTools,
  getDraftInputShape,
  revisionInputShape,
} from '@selecta/core/tools/playlist_draft.js';
import type { DraftStore } from '@selecta/core/drafts/store.js';
import { BRIEF_LIMIT, type Method } from '../shared/protocol.js';
import { ARTWORK_GET_LIMIT } from '../shared/artwork.js';
import type { AgentSessions } from './agent.js';
import type { ArtworkCache } from './artwork.js';
import { crate } from './library.js';
import { createPlayer } from './player.js';

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
const Revision = z.strictObject({ ...revisionInputShape });
const Play = z.strictObject({
  ...revisionInputShape,
  entry_id: z.string().uuid(),
  position: z.number().nonnegative().optional(),
});
const Seek = z.strictObject({ ...getDraftInputShape, position: z.number().nonnegative() });
const Artwork = z.strictObject({
  track_ids: z.array(z.string().max(64)).max(ARTWORK_GET_LIMIT),
});

export function createApi(
  deps: ToolDeps & { drafts: () => DraftStore },
  agent: AgentSessions,
  artwork: ArtworkCache,
) {
  const drafts = new PlaylistDraftTools(deps);
  const player = createPlayer({
    bridge: deps.bridge,
    cache: deps.cache,
    drafts: deps.drafts,
    preview: (args) => drafts.preview(args),
  });

  // The store refuses linked drafts atomically; this only fails a run before
  // it starts rather than partway through.
  function linked(draftId: string): boolean {
    const slot = deps.drafts().preview();

    return slot?.owner === draftId && slot.status !== 'inactive';
  }

  const LINKED =
    "Claude can't edit this draft while it plays through the Selecta Preview playlist in Music. Stop listening to send it feedback.";

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
    'player.state': (args) => player.state(DraftId.parse(args).draft_id),
    'player.play': (args) => {
      const { draft_id, revision, entry_id, position } = Play.parse(args);

      return player.play(draft_id, revision, entry_id, position);
    },
    'player.pause': (args) => player.control(DraftId.parse(args).draft_id, { action: 'pause' }),
    'player.resume': (args) => player.control(DraftId.parse(args).draft_id, { action: 'resume' }),
    'player.seek': (args) => {
      const { draft_id, position } = Seek.parse(args);

      return player.control(draft_id, { action: 'seek', position });
    },
    'player.detach': (args) => {
      const { draft_id, revision } = Revision.parse(args);

      return player.detach(draft_id, revision);
    },
  };

  return async (method: string, args: unknown): Promise<unknown> => {
    if (!Object.hasOwn(handlers, method)) throw new Error(`Unknown method: ${method}`);

    return handlers[method as Method](args);
  };
}
