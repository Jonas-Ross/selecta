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

import type { FeatureSource } from '../types/cache.js';
import type { SourceField } from '../cache/audio_features.js';

/**
 * What each pass can actually put in a row.
 *
 * Analysis is metrognome, which measures tempo and key and nothing else
 * (`toFeaturesRow`); only the catalogs carry danceability. Reopening a field
 * its source cannot supply would re-run the whole backlog to fill nothing and
 * mark every track terminal again, so callers check here first.
 * `test/enrich.test.ts` pins this to what the adapters really write.
 */
export const FIELDS_BY_SOURCE: Record<FeatureSource, readonly SourceField[]> = {
  catalog: ['bpm', 'musicalKey', 'danceability'],
  analysis: ['bpm', 'musicalKey'],
};
