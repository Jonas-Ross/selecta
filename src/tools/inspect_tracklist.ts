// inspect_tracklist — cache-only facts about an ordered playlist draft.

import {
  buildTracklistInspection,
  type TracklistInspection,
} from '../domain/tracklist_inspection.js';
import { z } from 'zod';
import { trackNotFoundError, type SelectaError } from '../types/errors.js';
import { parseInput, toErrorEnvelope } from './errors.js';
import { roundCacheAge } from './freshness.js';
import type { ToolDeps } from './deps.js';

const MAX_TRACKS = 500;

export const inspectTracklistInputShape = {
  track_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_TRACKS)
    .describe('Track persistent IDs in the exact draft order (max 500).'),
};

const InspectTracklistInput = z.strictObject(inspectTracklistInputShape);

export type InspectTracklistOutput = TracklistInspection & {
  cache_age_hours: number | null;
};

export const INSPECT_TRACKLIST_DESCRIPTION = `Inspect an ordered playlist draft using only Selecta's local cache, before preview_playlist or create_playlist. Returns the resolved tracks in the exact supplied order, known runtime (with any missing-duration IDs), exact repeated IDs, distinct owned copies of the same trimmed/case-insensitive title + artist where detectable, artist occurrence counts, raw play/skip/loved/rating signal, each track's camelot wheel position where its key is known ("11A" — neighbouring numbers and the A/B pair sharing a number mix cleanly), BPM/key/danceability coverage, grouped feature gaps naming affected track IDs once per missing-field combination, harmonic facts about every adjacent pair, and a fingerprint. Duplicate positions are 0-based. The fingerprint is SHA-256 over the UTF-8 JSON array of supplied IDs, including order and duplicates; to compare a later draft, inspect that later ordered ID list and compare fingerprints (write tools do not accept it). Unknown IDs fail with track_not_found and no partial inspection. Unlike search and get_track_context, tracks here also carry bpm_confidence / key_confidence (0-1, how sure the estimator was of this measurement) and bpm_maturity / key_maturity (validated or provisional, how far that estimator has been checked at all) — absent means unrecorded. A provisional key is a hint however high its confidence reads, so weigh it before building a transition on it. harmonic.transitions has one entry per adjacent pair in order, keyed by from_position (0-based, so a repeated track gets a separate entry each time it appears), naming how the two wheel positions relate: same (identical key), adjacent (one step round the wheel, a fifth apart), relative (the A/B pair on one number, relative minor/major), energy_boost (two steps up), distant (anything else), unknown (either side has no position). The Camelot convention treats the first four as clean mixes and distant as a clash — that reading is yours; Selecta reports only the geometry. provisional: true marks a transition resting on a provisional key estimate. harmonic.by_relation counts each relation, and unknown_key_positions / provisional_key_positions list the positions behind those caveats — a key Selecta does not have is never guessed. A key with no mode ("F" rather than "F minor") has no wheel position, so unknown_key_positions is not the same set as the musical_key feature gap. Reports facts only — no transition score, variety judgment, quality flag, or recommendation. Never reads Music.app or the network.`;

export async function handleInspectTracklist(
  raw: unknown,
  deps: ToolDeps,
): Promise<InspectTracklistOutput | SelectaError> {
  const parsed = parseInput(InspectTracklistInput, raw);

  if (!parsed.ok) return parsed.error;

  try {
    const { rows, missingIds, cacheAgeHours } = deps.cache().resolveTracks(parsed.data.track_ids);

    if (missingIds.length > 0) return trackNotFoundError(missingIds);

    return {
      ...buildTracklistInspection(rows),
      cache_age_hours: roundCacheAge(cacheAgeHours),
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
