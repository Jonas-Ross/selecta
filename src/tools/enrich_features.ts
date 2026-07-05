// enrich_features — work through the audio-feature backlog one bounded batch
// at a time. Deliberately its own tool rather than a side effect of
// refresh_library: it calls external services and takes ~1-2s per track, so
// invoking it is the model's explicit decision, never hidden behavior.

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import { enrichPendingTracks } from '../enrich/index.js';
import { parseInput, toErrorEnvelope, type ToolDeps } from './common.js';

const DEFAULT_LIMIT = 25;

export const enrichFeaturesInputShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      `Tracks to attempt this call (default ${DEFAULT_LIMIT}). Source rate limits (MusicBrainz 1 req/s, AcousticBrainz 10 req/10s) pace the run at ~1-3s per track — size the batch to how long you're willing to wait.`,
    ),
};

const EnrichFeaturesInput = z.strictObject(enrichFeaturesInputShape);

export type EnrichFeaturesOutput = {
  processed: number;
  enriched: number;
  no_data: number;
  no_match: number;
  pending_remaining: number;
  // Present only when a source outage skipped chunks: those tracks stay
  // pending (counted in pending_remaining) and are picked up by a later call.
  skipped?: number;
  source_errors?: string[];
};

export const ENRICH_FEATURES_DESCRIPTION = `Fetch audio features (bpm, musical_key, danceability) for owned tracks not yet attempted, from free public sources (MusicBrainz→AcousticBrainz, Deezer; network required, no keys). One call processes one batch (~1-3s per track; source rate limits are honored automatically), most-played tracks first, saving in 25-track chunks; call again while pending_remaining > 0. Attempted tracks are terminal — no_match / no_data are recorded and never retried, so coverage is partial by nature (bpm lands on roughly half a typical library; recent releases are weakest). Features then appear on search / get_track_context results. Chunks that hit a source outage (AcousticBrainz throws intermittent 5xx) are skipped, reported in skipped/source_errors, and their tracks stay pending — call again later to pick them up; nothing is retried within a run. For a first-time backfill of a whole library prefer the CLI: node dist/index.js enrich.`;

export async function handleEnrichFeatures(
  raw: unknown,
  deps: ToolDeps,
): Promise<EnrichFeaturesOutput | SelectaError> {
  const parsed = parseInput(EnrichFeaturesInput, raw ?? {});
  if (!parsed.ok) return parsed.error;

  try {
    const summary = await enrichPendingTracks(
      deps.cache(),
      { limit: parsed.data.limit ?? DEFAULT_LIMIT },
      deps.enrich ?? {},
    );
    return {
      processed: summary.processed,
      enriched: summary.enriched,
      no_data: summary.noData,
      no_match: summary.noMatch,
      pending_remaining: summary.pendingRemaining,
      ...(summary.skipped > 0
        ? { skipped: summary.skipped, source_errors: summary.errors }
        : {}),
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
