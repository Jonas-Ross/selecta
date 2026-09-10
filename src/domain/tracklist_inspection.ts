// Pure ordered-track facts once the cache boundary has resolved every ID.
import { createHash } from 'node:crypto';
import { occurrencePositions } from './occurrence_positions.js';
import { songIdentityKey } from '../cache/song_identity.js';
import type { TrackRow } from '../types/cache.js';
import { toApiTrack, toInspectedTrack, type InspectedTrack } from './track_projections.js';

type FeatureCoverage = {
  present_count: number;
  missing_count: number;
};

type FeatureName = 'bpm' | 'musical_key' | 'danceability';

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
    bpm: FeatureCoverage;
    musical_key: FeatureCoverage;
    danceability: FeatureCoverage;
  };
  feature_gaps: { missing: FeatureName[]; track_ids: string[] }[];
};

export function orderedTrackIdsFingerprint(trackIds: string[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(trackIds), 'utf8').digest('hex')}`;
}

function duplicateOwnedCopies(
  rows: TrackRow[],
  positions: Map<string, number[]>,
): TracklistInspection['duplicate_owned_copies'] {
  const groups = new Map<string, { title: string; artist: string; persistentIds: Set<string> }>();

  for (const row of rows) {
    const title = row.title?.trim();
    const artist = row.artist?.trim();

    if (!title || !artist) continue;

    const key = songIdentityKey(row.title, row.artist, row.persistentId);
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

function featureFacts(rows: TrackRow[]): {
  coverage: TracklistInspection['feature_coverage'];
  gaps: TracklistInspection['feature_gaps'];
} {
  const present = { bpm: 0, musical_key: 0, danceability: 0 };
  const groups = new Map<string, { missing: FeatureName[]; trackIds: Set<string> }>();

  for (const row of rows) {
    const missing: FeatureName[] = [];

    if (row.bpm == null) missing.push('bpm');
    else present.bpm += 1;

    if (row.musicalKey == null) missing.push('musical_key');
    else present.musical_key += 1;

    if (row.danceability == null) missing.push('danceability');
    else present.danceability += 1;

    if (missing.length === 0) continue;

    const key = missing.join(',');
    const group = groups.get(key);

    if (group) group.trackIds.add(row.persistentId);
    else groups.set(key, { missing, trackIds: new Set([row.persistentId]) });
  }

  return {
    coverage: {
      bpm: { present_count: present.bpm, missing_count: rows.length - present.bpm },
      musical_key: {
        present_count: present.musical_key,
        missing_count: rows.length - present.musical_key,
      },
      danceability: {
        present_count: present.danceability,
        missing_count: rows.length - present.danceability,
      },
    },
    gaps: [...groups.values()].map(({ missing, trackIds }) => ({
      missing,
      track_ids: [...trackIds],
    })),
  };
}

/** Pure aggregation once the cache boundary has resolved every input ID. */
export function buildTracklistInspection(rows: TrackRow[]): TracklistInspection {
  const trackIds = rows.map((row) => row.persistentId);
  const positions = occurrencePositions(trackIds);
  const runtimeMissing = rows.filter((row) => row.durationSeconds == null);
  const { artistCounts, unknownArtistCount } = artistOccurrences(rows);
  const { coverage, gaps } = featureFacts(rows);

  return {
    fingerprint: orderedTrackIdsFingerprint(trackIds),
    track_count: rows.length,
    tracks: rows.map((row) => toInspectedTrack(toApiTrack(row))),
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
    feature_coverage: coverage,
    feature_gaps: gaps,
  };
}
