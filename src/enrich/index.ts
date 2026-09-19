// Public surface of the enrichment layer. Like bridge/, an external-world
// adapter (MusicBrainz/AcousticBrainz, Deezer) usable as a plain library —
// only tools/ knows MCP exists.

export {
  enrichPendingTracks,
  type EnrichDeps,
  type EnrichOptions,
  type EnrichmentProgress,
  type EnrichmentSummary,
  type TargetedEnrichmentOutcome,
} from './engine.js';
export type { FetchLike } from './sources.js';
export {
  METROGNOME_PATH_ENV,
  analyzeTracks,
  metrognomePath,
  toFeaturesRow,
  type ChildLike,
  type MetrognomeDeps,
} from './metrognome.js';
