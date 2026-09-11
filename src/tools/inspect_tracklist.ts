// inspect_tracklist — cache-only facts about an ordered playlist draft.

import {
  buildTracklistInspection,
  type TracklistInspection,
} from '../domain/tracklist_inspection.js';
import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import { missingTrackIdsError } from '../operations/resources.js';
import { parseInput, toErrorEnvelope } from './errors.js';
import { readRoundedCacheAge } from './freshness.js';
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

export const INSPECT_TRACKLIST_DESCRIPTION = `Inspect an ordered playlist draft using only Selecta's local cache, before preview_playlist or create_playlist. Returns the resolved tracks in the exact supplied order, known runtime (with any missing-duration IDs), exact repeated IDs, distinct owned copies of the same trimmed/case-insensitive title + artist where detectable, artist occurrence counts, raw play/skip/loved/rating signal, BPM/key/danceability coverage, grouped feature gaps naming affected track IDs once per missing-field combination, and a fingerprint. Duplicate positions are 0-based. The fingerprint is SHA-256 over the UTF-8 JSON array of supplied IDs, including order and duplicates; to compare a later draft, inspect that later ordered ID list and compare fingerprints (write tools do not accept it). Unknown IDs fail with track_not_found and no partial inspection. Reports facts only — no transition score, variety judgment, quality flag, or recommendation. Never reads Music.app or the network.`;

export async function handleInspectTracklist(
  raw: unknown,
  deps: ToolDeps,
): Promise<InspectTracklistOutput | SelectaError> {
  const parsed = parseInput(InspectTracklistInput, raw);

  if (!parsed.ok) return parsed.error;

  try {
    const cache = deps.cache();
    const uniqueTrackIds = [...new Set(parsed.data.track_ids)];
    const cacheMiss = missingTrackIdsError(cache, uniqueTrackIds);

    if (cacheMiss) return cacheMiss;

    // Resolution is deliberately separate from aggregation: a miss returns
    // above before the pure builder can produce even a partial inspection.
    const rows = parsed.data.track_ids.map((id) => cache.getTrack(id)!);

    return {
      ...buildTracklistInspection(rows),
      cache_age_hours: readRoundedCacheAge(deps),
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
