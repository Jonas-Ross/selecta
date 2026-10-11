// The renderer's whole view of the app: every call it can make and every event
// it can receive. The host validates arguments; these types only keep the two
// ends honest at compile time.
import type { toInspectedTrack } from '@selecta/core/domain/track_projections.js';
import type { DraftSummary } from '@selecta/core/drafts/store.js';
import type { PlaybackView } from '@selecta/core/operations/playback.js';
import type { ArtworkReadResult } from '@selecta/core/types/bridge.js';

export type { DraftSummary };

export const BRIEF_LIMIT = 4000;

export type CrateTrack = ReturnType<typeof toInspectedTrack> & { genre?: string; year?: number };
export type Crate = { tracks: CrateTrack[]; total: number; order: 'recently_added' | 'relevance' };

/** A cached thumbnail's file name, null when the track has no artwork, or why it couldn't be read. */
export type ArtworkAnswer = ArtworkReadResult[string];

export type PlayerView = PlaybackView;

export type Methods = {
  'library.crate': (args: { query?: string }) => Crate;
  'artwork.get': (args: {
    track_ids: string[];
    refresh?: string[];
  }) => Record<string, ArtworkAnswer>;
  'drafts.list': () => DraftSummary[];
  'drafts.get': (args: { draft_id: string }) => unknown;
  'drafts.edit': (args: Record<string, unknown>) => unknown;
  'drafts.save': (args: { draft_id: string; revision: number }) => unknown;
  'agent.providers': () => ProviderStatus[];
  'agent.start': (args: { draft_id: string; brief: string; provider?: ProviderId }) => void;
  'agent.send': (args: {
    draft_id: string;
    message: string;
    text?: string;
    provider?: ProviderId;
  }) => void;
  'agent.cancel': (args: { draft_id: string }) => void;
  'agent.history': () => Record<string, RunSnapshot>;
  'player.state': (args: { draft_id: string }) => PlayerView;
  'player.play': (args: {
    draft_id: string;
    revision: number;
    entry_id: string;
    position?: number;
  }) => PlayerView;
  'player.pause': (args: { draft_id: string }) => PlayerView;
  'player.resume': (args: { draft_id: string }) => PlayerView;
  'player.seek': (args: { draft_id: string; position: number }) => PlayerView;
  'player.detach': (args: { draft_id: string; revision: number }) => void;
};

export type Method = keyof Methods;

export const PROVIDER_IDS = ['claude', 'codex'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const PROVIDER_LABELS: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex' };

/** An agent CLI the app can drive, and why it can't run yet when it can't. */
export type ProviderStatus = { id: ProviderId; label: string; ready: boolean; problem?: string };

export type AgentEvent =
  | { kind: 'asked'; text: string; brief?: true; by?: ProviderId }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'denied'; name: string }
  | { kind: 'done'; session_id?: string }
  | { kind: 'error'; message: string };

/** Everything a draft's runs have reported, so a reloaded renderer can catch up. */
export type RunSnapshot = { events: AgentEvent[]; working: boolean };

export type HostEvent =
  | { event: 'agent'; draft_id: string; seq: number; data: AgentEvent }
  | { event: 'drafts.changed' };

export type SelectaApi = {
  call<M extends Method>(
    method: M,
    ...args: Parameters<Methods[M]>
  ): Promise<Awaited<ReturnType<Methods[M]>>>;
  on(listener: (event: HostEvent) => void): () => void;
};
