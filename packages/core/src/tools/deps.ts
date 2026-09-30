import type { Bridge } from '../types/bridge.js';
import type { SelectaCache } from '../cache/index.js';
import type { DraftStore } from '../drafts/store.js';
import type { EnrichDeps } from '../enrich/index.js';

// cache is a lazy getter so a broken cache (unwritable dir, corrupt file)
// surfaces per-call as a cache_unavailable envelope instead of crashing the
// server at startup — and cold start stays under the 200ms budget.
// enrich overrides the enrichment engine's fetch/clock/timer — tests inject
// canned sources here; production leaves it unset for the real network.
// drafts follows the same pattern so every entry point that isolates the
// cache path isolates the draft store with it.
export type ToolDeps = {
  cache: () => SelectaCache;
  bridge: Bridge;
  enrich?: EnrichDeps;
  drafts?: () => DraftStore;
};
