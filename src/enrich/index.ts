// Public surface of the enrichment layer. Like bridge/, an external-world
// adapter (MusicBrainz/AcousticBrainz, Deezer) usable as a plain library —
// only tools/ knows MCP exists.

export {
  enrichPendingTracks,
  type EnrichDeps,
  type EnrichmentProgress,
  type EnrichmentSummary,
} from './engine.js';
export type { FetchLike } from './sources.js';
