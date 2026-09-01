// enrich_features — attempt one bounded targeted batch or work through the
// audio-feature backlog. Deliberately its own tool rather than a side effect of
// refresh_library: it calls external services and takes ~1-2s per track, so
// invoking it is the model's explicit decision, never hidden behavior.

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import { enrichPendingTracks, type TargetedEnrichmentOutcome } from '../enrich/index.js';
import { parseInput, toErrorEnvelope, validationError, type ToolDeps } from './common.js';

const DEFAULT_LIMIT = 25;
const MAX_BATCH_SIZE = 50;

export const enrichFeaturesInputShape = {
  // Capped at 50: at ~1-3s/track a bigger batch runs past the ~60s tool-call
  // timeout some MCP clients enforce. A timeout only loses result visibility
  // (chunks save as they land), but the CLI is the right tool for bulk work.
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_BATCH_SIZE)
    .optional()
    .describe(
      `Backlog tracks to attempt this call (default ${DEFAULT_LIMIT}); omit when using track_ids. Source rate limits (MusicBrainz 1 req/s, AcousticBrainz 10 req/10s) pace the run at ~1-3s per track — size the batch to how long you're willing to wait.`,
    ),
  track_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_BATCH_SIZE)
    .refine((ids) => new Set(ids).size === ids.length, 'must not contain duplicate IDs')
    .optional()
    .describe(
      `Specific track persistent IDs to attempt (up to ${MAX_BATCH_SIZE}). Only still-pending tracks are queried; already-terminal tracks are reported and never retried. Cannot be combined with limit.`,
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
  // Targeted mode only: every requested ID, including terminal tracks that
  // were deliberately not retried.
  already_attempted?: number;
  track_outcomes?: TargetedTrackOutcome[];
};

type TargetedTrackOutcome =
  | { track_id: string; outcome: 'enriched' | 'no_data' | 'no_match' | 'skipped' }
  | {
      track_id: string;
      outcome: 'already_attempted';
      existing_result: 'enriched' | 'no_data' | 'no_match';
    };

export const ENRICH_FEATURES_DESCRIPTION = `Fetch audio features (bpm, musical_key, danceability) for owned tracks not yet attempted, from free public sources (MusicBrainz→AcousticBrainz, Deezer; network required, no keys). Two modes: pass track_ids (up to ${MAX_BATCH_SIZE}) to attempt only those specific pending tracks, or omit track_ids to process the most-played backlog using limit (default ${DEFAULT_LIMIT}, max ${MAX_BATCH_SIZE}); don't combine track_ids with limit. Targeted calls report one track_outcomes entry per ID: enriched, no_data, no_match, skipped, or already_attempted with its existing result. Unknown IDs fail with track_not_found before any external request. One call runs at ~1-3s per attempted track; source rate limits are honored automatically, and results save in 25-track chunks. Attempted tracks are terminal — no_match / no_data are recorded and never retried, so coverage is partial by nature (bpm lands on roughly half a typical library; recent releases are weakest). Features then appear on search / get_track_context results. Chunks that hit a source outage (AcousticBrainz throws intermittent 5xx) are skipped, reported in skipped/source_errors, and their tracks stay pending — call again later to pick them up; nothing is retried within a run. For a first-time backfill of a whole library prefer the CLI: node dist/index.js enrich.`;

function toTrackOutcome(outcome: TargetedEnrichmentOutcome): TargetedTrackOutcome {
  return outcome.outcome === 'already_attempted'
    ? {
        track_id: outcome.trackPersistentId,
        outcome: outcome.outcome,
        existing_result: outcome.existingResult,
      }
    : { track_id: outcome.trackPersistentId, outcome: outcome.outcome };
}

export async function handleEnrichFeatures(
  raw: unknown,
  deps: ToolDeps,
): Promise<EnrichFeaturesOutput | SelectaError> {
  const parsed = parseInput(EnrichFeaturesInput, raw ?? {});
  if (!parsed.ok) return parsed.error;
  if (parsed.data.track_ids != null && parsed.data.limit != null) {
    return validationError('track_ids and limit select different modes; provide only one.');
  }

  try {
    const options =
      parsed.data.track_ids != null
        ? { trackIds: parsed.data.track_ids }
        : { limit: parsed.data.limit ?? DEFAULT_LIMIT };
    const summary = await enrichPendingTracks(
      deps.cache(),
      options,
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
      ...(summary.outcomes != null
        ? {
            already_attempted: summary.alreadyAttempted ?? 0,
            track_outcomes: summary.outcomes.map(toTrackOutcome),
          }
        : {}),
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
