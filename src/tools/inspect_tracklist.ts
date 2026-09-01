// inspect_tracklist — cache-only facts about an ordered playlist draft.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TrackRow } from '../types/cache.js';
import type { SelectaError } from '../types/errors.js';
import {
  missingTrackIdsError,
  parseInput,
  roundedCacheAge,
  toErrorEnvelope,
  type ToolDeps,
} from './common.js';

const MAX_TRACKS = 500;

export const inspectTracklistInputShape = {
  track_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_TRACKS)
    .describe('Track persistent IDs in the exact draft order (max 500).'),
};

const InspectTracklistInput = z.strictObject(inspectTracklistInputShape);

export type InspectedTrack = {
  persistent_id: string;
  title?: string;
  artist?: string;
  album?: string;
  duration_seconds?: number;
  bpm?: number;
  musical_key?: string;
  danceability?: number;
  signal: {
    play_count: number;
    skip_count: number;
    rating: number | null;
    loved: boolean;
  };
};

type MissingCoverage = {
  present_count: number;
  missing_count: number;
  missing_track_ids: string[];
};

export type TracklistInspection = {
  fingerprint: string;
  track_count: number;
  tracks: InspectedTrack[];
  runtime: {
    // Sum of the durations Selecta knows. It is the exact total when
    // missing_track_ids is empty, and an explicitly incomplete subtotal when
    // it is not.
    known_seconds: number;
    missing_count: number;
    missing_track_ids: string[];
  };
  duplicate_ids: {
    persistent_id: string;
    count: number;
    positions: number[];
  }[];
  duplicate_owned_copies: {
    title: string;
    artist: string;
    copies: {
      persistent_id: string;
      positions: number[];
    }[];
  }[];
  artist_counts: { artist: string; count: number }[];
  unknown_artist_count: number;
  feature_coverage: {
    bpm: MissingCoverage;
    musical_key: MissingCoverage;
    danceability: MissingCoverage;
  };
};

export type InspectTracklistOutput = TracklistInspection & {
  cache_age_hours: number | null;
};

export const INSPECT_TRACKLIST_DESCRIPTION = `Inspect an ordered playlist draft using only Selecta's local cache, before preview_playlist or create_playlist. Returns the resolved tracks in the exact supplied order, known runtime (with any missing-duration IDs), exact repeated IDs, distinct owned copies of the same trimmed/case-insensitive title + artist where detectable, artist occurrence counts, raw play/skip/loved/rating signal, BPM/key/danceability coverage and missing IDs, and a sha256 fingerprint of the ordered ID array. Duplicate positions are 0-based. The fingerprint matches only the identical ordered ID list. Unknown IDs fail with track_not_found and no partial inspection. Reports facts only — no transition score, variety judgment, quality flag, or recommendation. Never reads Music.app or the network.`;

function compactTrack(row: TrackRow): InspectedTrack {
  return {
    persistent_id: row.persistentId,
    title: row.title ?? undefined,
    artist: row.artist ?? undefined,
    album: row.album ?? undefined,
    duration_seconds: row.durationSeconds ?? undefined,
    bpm: row.bpm != null ? Math.round(row.bpm * 10) / 10 : undefined,
    musical_key: row.musicalKey ?? undefined,
    danceability:
      row.danceability != null ? Math.round(row.danceability * 100) / 100 : undefined,
    signal: {
      play_count: row.playCount,
      skip_count: row.skipCount,
      rating: row.rating != null ? row.rating / 20 : null,
      loved: row.loved === 1,
    },
  };
}

function positionsById(rows: TrackRow[]): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  rows.forEach((row, position) => {
    const existing = positions.get(row.persistentId);
    if (existing) existing.push(position);
    else positions.set(row.persistentId, [position]);
  });
  return positions;
}

function duplicateOwnedCopies(
  rows: TrackRow[],
  positions: Map<string, number[]>,
): TracklistInspection['duplicate_owned_copies'] {
  const groups = new Map<
    string,
    { title: string; artist: string; persistentIds: Set<string> }
  >();

  for (const row of rows) {
    const title = row.title?.trim();
    const artist = row.artist?.trim();
    if (!title || !artist) continue;
    const key = `${title.toLowerCase()}\u001f${artist.toLowerCase()}`;
    const existing = groups.get(key);
    if (existing) existing.persistentIds.add(row.persistentId);
    else groups.set(key, { title, artist, persistentIds: new Set([row.persistentId]) });
  }

  return [...groups.values()]
    .filter((group) => group.persistentIds.size > 1)
    .map((group) => ({
      title: group.title,
      artist: group.artist,
      copies: [...group.persistentIds].map((persistent_id) => ({
        persistent_id,
        positions: positions.get(persistent_id)!,
      })),
    }));
}

function artistOccurrences(rows: TrackRow[]): {
  artistCounts: TracklistInspection['artist_counts'];
  unknownArtistCount: number;
} {
  const counts = new Map<string, { artist: string; count: number }>();
  let unknownArtistCount = 0;
  for (const row of rows) {
    const artist = row.artist?.trim();
    if (!artist) {
      unknownArtistCount += 1;
      continue;
    }
    const key = artist.toLowerCase();
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { artist, count: 1 });
  }
  return { artistCounts: [...counts.values()], unknownArtistCount };
}

function featureCoverage<T>(
  rows: TrackRow[],
  valueOf: (row: TrackRow) => T | null,
): MissingCoverage {
  const missingRows = rows.filter((row) => valueOf(row) == null);
  return {
    present_count: rows.length - missingRows.length,
    missing_count: missingRows.length,
    missing_track_ids: [...new Set(missingRows.map((row) => row.persistentId))],
  };
}

/** Pure aggregation once the cache boundary has resolved every input ID. */
export function buildTracklistInspection(rows: TrackRow[]): TracklistInspection {
  const trackIds = rows.map((row) => row.persistentId);
  const positions = positionsById(rows);
  const runtimeMissing = rows.filter((row) => row.durationSeconds == null);
  const { artistCounts, unknownArtistCount } = artistOccurrences(rows);

  return {
    fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(trackIds)).digest('hex')}`,
    track_count: rows.length,
    tracks: rows.map(compactTrack),
    runtime: {
      known_seconds: rows.reduce((sum, row) => sum + (row.durationSeconds ?? 0), 0),
      missing_count: runtimeMissing.length,
      missing_track_ids: [...new Set(runtimeMissing.map((row) => row.persistentId))],
    },
    duplicate_ids: [...positions.entries()]
      .filter(([, occurrences]) => occurrences.length > 1)
      .map(([persistent_id, occurrences]) => ({
        persistent_id,
        count: occurrences.length,
        positions: occurrences,
      })),
    duplicate_owned_copies: duplicateOwnedCopies(rows, positions),
    artist_counts: artistCounts,
    unknown_artist_count: unknownArtistCount,
    feature_coverage: {
      bpm: featureCoverage(rows, (row) => row.bpm),
      musical_key: featureCoverage(rows, (row) => row.musicalKey),
      danceability: featureCoverage(rows, (row) => row.danceability),
    },
  };
}

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
      cache_age_hours: roundedCacheAge(deps),
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
