// The renderer's whole view of the app: every call it can make and every event
// it can receive. The host validates arguments; these types only keep the two
// ends honest at compile time.
import type { DraftSummary } from '@selecta/core/drafts/store.js';

export type { DraftSummary };

export const BRIEF_LIMIT = 4000;

export type Methods = {
  'drafts.list': () => DraftSummary[];
  'drafts.get': (args: { draft_id: string }) => unknown;
  'drafts.edit': (args: Record<string, unknown>) => unknown;
  'drafts.save': (args: { draft_id: string; revision: number }) => unknown;
  'agent.start': (args: { draft_id: string; brief: string }) => void;
  'agent.send': (args: { draft_id: string; message: string; text?: string }) => void;
  'agent.cancel': (args: { draft_id: string }) => void;
  'agent.history': () => Record<string, RunSnapshot>;
};

export type Method = keyof Methods;

export type AgentEvent =
  | { kind: 'asked'; text: string }
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
