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
import { createPlayback } from '@selecta/core/operations/playback.js';
import { BRIEF_LIMIT, PROVIDER_IDS, type Method, type ProviderStatus } from '../shared/protocol.js';
import { ARTWORK_GET_LIMIT } from '../shared/artwork.js';
import type { AgentSessions } from './agent.js';
import type { ArtworkCache } from './artwork.js';
import { crate } from './library.js';

const DraftId = z.strictObject(getDraftInputShape);
const Provider = z.enum(PROVIDER_IDS).optional();
const Brief = z.strictObject({
  ...getDraftInputShape,
  brief: z.string().trim().min(1).max(BRIEF_LIMIT),
  provider: Provider,
});
const Message = z.strictObject({
  ...getDraftInputShape,
  // Selected tracks ride along one line each, up to a draft's 500 entries.
  message: z.string().trim().min(1).max(60_000),
  // What the user typed, for the log; the message adds the selected tracks.
  text: z.string().max(60_000).optional(),
  provider: Provider,
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
  refresh: z.array(z.string().max(64)).max(ARTWORK_GET_LIMIT).optional(),
});

export function createApi(
  deps: ToolDeps & { drafts: () => DraftStore },
  agent: AgentSessions,
  artwork: ArtworkCache,
  providers: () => Promise<ProviderStatus[]>,
) {
  const drafts = new PlaylistDraftTools(deps);
  const player = createPlayback(deps);

  // The store refuses linked drafts atomically; this only fails a run before
  // it starts rather than partway through.
  function linked(draftId: string): boolean {
    const slot = deps.drafts().preview();

    return slot?.owner === draftId && slot.status !== 'inactive';
  }

  const linkedMessage = (draftId: string) =>
    `${agent.provider(draftId).label} can't edit this draft while it plays through the Selecta Preview playlist in Music. Stop listening to send it feedback.`;

  const handlers: Record<Method, (args: unknown) => unknown> = {
    'library.crate': (args) => crate(deps.cache(), args),
    'artwork.get': (args) => {
      const { track_ids, refresh } = Artwork.parse(args);

      return artwork.get(track_ids, refresh);
    },
    'drafts.list': () => deps.drafts().list(),
    'drafts.get': (args) => drafts.get(args),
    'drafts.edit': (args) => drafts.edit(args),
    'drafts.save': (args) => drafts.save(args),
    'agent.providers': () => providers(),
    'agent.start': (args) => {
      const { draft_id, brief, provider } = Brief.parse(args);

      if (linked(draft_id)) agent.refuse(draft_id, brief, linkedMessage(draft_id), true);
      else agent.start(draft_id, brief, provider);
    },
    'agent.send': (args) => {
      const { draft_id, message, text, provider } = Message.parse(args);

      if (linked(draft_id)) agent.refuse(draft_id, text ?? message, linkedMessage(draft_id));
      else agent.send(draft_id, message, text, provider);
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
