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
import { enrichPendingTracks } from '@selecta/core/enrich/engine.js';
import { BridgeError } from '@selecta/core/types/errors.js';
import {
  ASK_LIMIT,
  BRIEF_LIMIT,
  HEARD_LIMIT,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  type Method,
  type ProviderId,
  type ProviderStatus,
  type Suggestion,
} from '../shared/protocol.js';
import { ARTWORK_GET_LIMIT } from '../shared/artwork.js';
import type { AgentSessions } from './agent.js';
import type { ArtworkCache } from './artwork.js';
import { crate, crateTrack } from './library.js';
import { createMeasurer, heard } from './measure.js';
import { SUGGEST_LIMIT, parsePicks, suggestPrompt } from './suggest.js';

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
const Suggest = z.strictObject({
  ...getDraftInputShape,
  entry_id: z.string().uuid(),
  ask: z.string().trim().max(ASK_LIMIT).optional(),
  exclude: z.array(z.string().max(64)).max(100).optional(),
  provider: Provider,
});
// A record and its neighbours, or fewer at either end of the draft.
const Audition = z.strictObject({
  track_ids: z.array(z.string().min(1).max(64)).min(1).max(3),
  index: z.number().int().nonnegative(),
  position: z.number().nonnegative().optional(),
});
const TrackId = z.strictObject({ track_id: z.string().min(1).max(64) });
const TrackIds = z.strictObject({
  track_ids: z.array(z.string().min(1).max(64)).max(HEARD_LIMIT),
});
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
  const features = (trackId: string) => deps.cache().getAudioFeatures(trackId) ?? undefined;
  const measurer = createMeasurer({
    run: async (trackIds) => {
      const spawnLike = deps.enrich?.metrognome?.spawnLike;
      // Without a spawner to watch, assume the run reached the store.
      let started = spawnLike === undefined;
      const enrich = spawnLike && {
        ...deps.enrich,
        metrognome: {
          ...deps.enrich?.metrognome,
          spawnLike: ((command, args) => {
            const child = spawnLike(command, args);

            started = true;

            return child;
          }) satisfies typeof spawnLike,
        },
      };
      const summary = await enrichPendingTracks(
        deps.cache(),
        { trackIds, source: 'analysis' },
        enrich || deps.enrich,
      ).catch((error: unknown) => {
        if (error instanceof BridgeError && error.errorCode === 'operation_busy')
          throw new Error('Another measuring run is going. Try again once it finishes.');

        throw error;
      });

      return {
        skipped: (summary.outcomes ?? []).flatMap((o) =>
          o.outcome === 'skipped' ? [o.trackPersistentId] : [],
        ),
        errors: summary.errors,
        started,
      };
    },
    features,
  });

  // The store refuses linked drafts atomically; this only fails a run before
  // it starts rather than partway through.
  function linked(draftId: string): boolean {
    const slot = deps.drafts().preview();

    return slot?.owner === draftId && slot.status !== 'inactive';
  }

  // Named for the agent the user asked, which may not be the one the host last ran.
  const linkedMessage = (draftId: string, provider?: ProviderId) =>
    `${provider ? PROVIDER_LABELS[provider] : agent.provider(draftId).label} can't edit this draft while it plays through the Selecta Preview playlist in Music. Stop listening to send it feedback.`;

  async function suggest(args: unknown): Promise<Suggestion[]> {
    const { draft_id, entry_id, ask, exclude = [], provider } = Suggest.parse(args);
    const { entries } = deps.drafts().get(draft_id);
    const at = entries.findIndex((entry) => entry.entry_id === entry_id);
    const record = entries[at];
    // The record and its neighbours, which the picks are chosen to sit between.
    const site = (now: typeof entries) => {
      const i = now.findIndex((entry) => entry.entry_id === entry_id);

      return i < 0 ? undefined : JSON.stringify([-1, 0, 1].map((d) => now[i + d]?.track_id));
    };
    const before = site(entries);

    if (!record) throw new Error('That record is no longer in the draft.');

    const row = deps.cache().getTrack(record.track_id);
    const reply = await agent.suggest(
      draft_id,
      suggestPrompt({
        draftId: draft_id,
        position: at + 1,
        count: entries.length,
        trackId: record.track_id,
        title: row?.title ?? undefined,
        artist: row?.artist ?? undefined,
        brief: agent.brief(draft_id),
        ask: ask || undefined,
        exclude,
      }),
      provider,
    );
    // The agent is told the rules; these hold whatever it does, against the draft as it is now.
    const now = deps.drafts().get(draft_id).entries;

    if (site(now) !== before)
      throw new Error(
        `The draft changed around that record while ${agent.provider(draft_id).label} was looking. Try again.`,
      );

    const taken = new Set([...now.map((entry) => entry.track_id), ...exclude]);
    const picks: Suggestion[] = [];

    for (const { track_id, reason } of parsePicks(reply)) {
      const found = taken.has(track_id) ? null : deps.cache().getTrack(track_id);

      if (!found) continue;

      taken.add(track_id);
      picks.push({ track: crateTrack(found), reason });

      if (picks.length === SUGGEST_LIMIT) break;
    }

    if (!picks.length)
      throw new Error(
        `${agent.provider(draft_id).label} didn't find a stand-in. Try asking for something else.`,
      );

    return picks;
  }

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

      if (linked(draft_id)) agent.refuse(draft_id, brief, linkedMessage(draft_id, provider), true);
      else agent.start(draft_id, brief, provider);
    },
    'agent.send': (args) => {
      const { draft_id, message, text, provider } = Message.parse(args);

      if (linked(draft_id))
        agent.refuse(draft_id, text ?? message, linkedMessage(draft_id, provider));
      else agent.send(draft_id, message, text, provider);
    },
    'agent.cancel': (args) => agent.cancel(DraftId.parse(args).draft_id),
    'agent.history': () => agent.history(),
    'agent.suggest': suggest,
    'agent.stopSuggest': (args) => agent.stopSuggest(DraftId.parse(args).draft_id),
    'features.measure': (args) => measurer.measure(TrackId.parse(args).track_id),
    'features.heard': (args) => heard(TrackIds.parse(args).track_ids, features),
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
    'player.audition': (args) => {
      const { track_ids, index, position } = Audition.parse(args);

      if (index >= track_ids.length) throw new Error('Nothing to play at that place.');

      return player.audition(track_ids, index, position);
    },
    'player.auditionState': () => player.auditionState(),
    'player.auditionStop': () => player.stopAudition(),
  };

  const call = async (method: string, args: unknown): Promise<unknown> => {
    if (!Object.hasOwn(handlers, method)) throw new Error(`Unknown method: ${method}`);

    return handlers[method as Method](args);
  };

  return Object.assign(call, { stopMeasuring: () => measurer.stop() });
}
