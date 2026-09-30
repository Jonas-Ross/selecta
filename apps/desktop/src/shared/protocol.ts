// The renderer's whole view of the app: every call it can make and every event
// it can receive. The host validates arguments; these types only keep the two
// ends honest at compile time.
import type { DraftSummary } from '@selecta/core/drafts/store.js';

export type { DraftSummary };

export type Methods = {
  'drafts.list': () => DraftSummary[];
  'drafts.get': (args: { draft_id: string }) => unknown;
  'drafts.edit': (args: Record<string, unknown>) => unknown;
  'drafts.save': (args: { draft_id: string; revision: number }) => unknown;
  'agent.start': (args: { draft_id: string; brief: string }) => void;
  'agent.send': (args: { draft_id: string; message: string }) => void;
  'agent.cancel': (args: { draft_id: string }) => void;
  'agent.active': () => string[];
};

export type Method = keyof Methods;

export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'denied'; name: string }
  | { kind: 'done'; session_id?: string }
  | { kind: 'error'; message: string };

export type HostEvent =
  | { event: 'agent'; draft_id: string; data: AgentEvent }
  | { event: 'drafts.changed' };

export type SelectaApi = {
  call<M extends Method>(
    method: M,
    ...args: Parameters<Methods[M]>
  ): Promise<Awaited<ReturnType<Methods[M]>>>;
  on(listener: (event: HostEvent) => void): () => void;
};
