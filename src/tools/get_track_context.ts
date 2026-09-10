// get_track_context — the curatorial graph walk: seed +
// same-artist tracks + containing playlists + co-occurring tracks from the
// user's own playlists. With seed_ids, one aggregated co-occurrence view
// across the whole seed set instead of N single-seed calls.

import { summarizeIds } from '../types/errors.js';
import { z } from 'zod';
import { trackNotFoundError, type SelectaError } from '../types/errors.js';
import type { SelectaCache } from '../cache/index.js';
import type { PlaylistRef, SourcePlaylistAudit } from '../types/cache.js';
import {
  COMPACT_TRACK_FIELDS,
  projectApiTrack,
  type ApiTrack,
  type CompactApiTrack,
} from '../domain/track_projections.js';
import { parseInput, toErrorEnvelope, validationError } from './errors.js';
import { roundCacheAge } from './freshness.js';
import type { ToolDeps } from './deps.js';

const MAX_SEEDS = 20;
const MAX_EXCLUDED_PLAYLISTS = 500;

export const getTrackContextInputShape = {
  track_id: z
    .string()
    .min(1)
    .optional()
    .describe('Single seed track persistent ID (from search results).'),
  seed_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_SEEDS)
    .optional()
    .describe(
      `Seed track persistent IDs (up to ${MAX_SEEDS}) — returns co-occurrence aggregated across the set.`,
    ),
  exclude_playlist_ids: z
    .array(z.string().min(1))
    .max(MAX_EXCLUDED_PLAYLISTS)
    .optional()
    .describe(
      `Plain user-playlist IDs to omit from co-occurrence facts (max ${MAX_EXCLUDED_PLAYLISTS}). No automatic utility detection or weighting.`,
    ),
  max_playlist_tracks: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Omit source playlists above this factual cached track count before aggregation. No hidden default.',
    ),
  compact: z
    .boolean()
    .optional()
    .describe(
      'Use for broad discovery: tracks become fixed value rows aligned with track_fields and omit only location_kind; co-occurring candidates replace repeated shared_playlist_names with playlist_refs into the top-level playlist_legend of {id, name}. Default false returns the full shape.',
    ),
};

const GetTrackContextInput = z.strictObject(getTrackContextInputShape);

export type TrackContextOutput = {
  seed: ApiTrack;
  // The seed's play_history windows (issue #31), newest first: what changed
  // between consecutive refreshes. Sparse — rows exist only where a counter
  // moved; empty until refreshes have bracketed some listening.
  play_history: { at: string; plays: number; skips: number }[];
  same_artist: ApiTrack[];
  appearing_in_playlists: PlaylistRef[];
  co_occurring_tracks: (ApiTrack & {
    shared_playlist_count: number;
    shared_playlist_names: string[];
  })[];
  source_playlists: SourcePlaylistAudit;
  cache_age_hours: number | null;
};

export type MultiSeedContextOutput = {
  seeds: ApiTrack[];
  co_occurring_tracks: (ApiTrack & {
    total_shared_playlist_count: number;
    seeds_matched: number;
    shared_playlist_names: string[];
  })[];
  source_playlists: SourcePlaylistAudit;
  cache_age_hours: number | null;
};

export type CompactTrackContextOutput = Omit<
  TrackContextOutput,
  'seed' | 'same_artist' | 'co_occurring_tracks'
> & {
  track_fields: typeof COMPACT_TRACK_FIELDS;
  seed: CompactApiTrack;
  same_artist: CompactApiTrack[];
  co_occurring_tracks: {
    track: CompactApiTrack;
    shared_playlist_count: number;
    playlist_refs: number[];
  }[];
  playlist_legend: PlaylistRef[];
};

export type CompactMultiSeedContextOutput = Omit<
  MultiSeedContextOutput,
  'seeds' | 'co_occurring_tracks'
> & {
  track_fields: typeof COMPACT_TRACK_FIELDS;
  seeds: CompactApiTrack[];
  co_occurring_tracks: {
    track: CompactApiTrack;
    total_shared_playlist_count: number;
    seeds_matched: number;
    playlist_refs: number[];
  }[];
  playlist_legend: PlaylistRef[];
};

const SAME_ARTIST_CAP = 30;
const CO_OCCURRENCE_CAP = 50;
const MULTI_CO_OCCURRENCE_CAP = 100;
const PLAY_HISTORY_CAP = 12;

export const GET_TRACK_CONTEXT_DESCRIPTION = `Curatorial context from the user's own (hand-made) playlists — the strongest "belongs together" signal available. Exactly one of track_id / seed_ids. Single seed (track_id): the seed with signal, its play_history (per-refresh play/skip deltas, newest first, up to ${PLAY_HISTORY_CAP} windows — recent-rotation evidence; empty just means no refresh bracketed any listening yet), up to ${SAME_ARTIST_CAP} same-artist tracks (by play count), the playlists containing it, and up to ${CO_OCCURRENCE_CAP} co-occurring tracks ranked by shared-playlist count. Multiple seeds (seed_ids, up to ${MAX_SEEDS}): one call instead of N — up to ${MULTI_CO_OCCURRENCE_CAP} candidates, each with total_shared_playlist_count (co-occurrence summed across the seed set) and seeds_matched (how many seeds it appears alongside); seeds themselves are excluded, and same_artist/appearing_in_playlists are single-seed only. Set compact true for broad single- or multi-seed discovery. Every compact track is a fixed value row aligned positionally with top-level track_fields; null means unavailable. Rows keep persistent_id, title, artist, album, year, genre, duration_seconds, the complete comparison signal (including date_added), and audio features; only location_kind is omitted. Candidate rows sit under track beside their context facts. To avoid repeating playlist names, compact output adds playlist_legend entries shaped {id, name} and replaces shared_playlist_names with zero-based playlist_refs into that legend. On co-occurring candidates, playlist_refs always means shared playlists. The legend preserves exact names and persistent playlist IDs for follow-up calls. Full output keeps track objects and shared_playlist_names. Compact mode never changes ordering or silently truncates results. exclude_playlist_ids and max_playlist_tracks are optional factual source-playlist filters chosen by you and applied before aggregation; there is no automatic utility detection, hidden threshold, weighting, or similarity score. source_playlists audits user playlists containing a seed before filters (considered) and removed by either filter (excluded); shared-playlist facts contain included sources only. Counts are library facts, not a recommendation — ranking is yours. All tracks carry enriched audio features (bpm, musical_key, danceability) where known — use them to judge tempo/key fit around the seeds — and any note you stored earlier via set_note, verbatim. Call after resolving seeds via search and playlist IDs via list_playlists. On track_not_found or an unknown excluded playlist ID the cache may be stale; consider refresh_library.`;

type ResolvedContext = Extract<ReturnType<SelectaCache['contextSnapshot']>, { kind: 'resolved' }>;

function playlistLegend(tracks: { sharedPlaylists: PlaylistRef[] }[]): {
  entries: PlaylistRef[];
  refs: number[][];
} {
  const byId = new Map<string, PlaylistRef>();

  for (const track of tracks) {
    for (const playlist of track.sharedPlaylists) byId.set(playlist.id, playlist);
  }

  const entries = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const indexById = new Map(entries.map((playlist, index) => [playlist.id, index]));

  return {
    entries,
    refs: tracks.map((track) =>
      track.sharedPlaylists.map((playlist) => indexById.get(playlist.id)!).sort((a, b) => a - b),
    ),
  };
}

function multiSeedContext(
  context: ResolvedContext,
  compact: boolean,
): MultiSeedContextOutput | CompactMultiSeedContextOutput {
  const { seeds, coOccurrence, cacheAgeHours } = context;
  const common = {
    source_playlists: coOccurrence.sourcePlaylists,
    cache_age_hours: roundCacheAge(cacheAgeHours),
  };

  if (compact) {
    const legend = playlistLegend(coOccurrence.tracks);

    return {
      ...common,
      track_fields: COMPACT_TRACK_FIELDS,
      seeds: seeds.map((row) => projectApiTrack(row, true)),
      co_occurring_tracks: coOccurrence.tracks.map((track, index) => ({
        track: projectApiTrack(track, true),
        total_shared_playlist_count: track.totalSharedPlaylistCount,
        seeds_matched: track.seedsMatched,
        playlist_refs: legend.refs[index]!,
      })),
      playlist_legend: legend.entries,
    };
  }

  return {
    ...common,
    seeds: seeds.map((row) => projectApiTrack(row, false)),
    co_occurring_tracks: coOccurrence.tracks.map((track) => ({
      ...projectApiTrack(track, false),
      total_shared_playlist_count: track.totalSharedPlaylistCount,
      seeds_matched: track.seedsMatched,
      shared_playlist_names: track.sharedPlaylistNames,
    })),
  };
}

export async function handleGetTrackContext(
  raw: unknown,
  deps: ToolDeps,
): Promise<
  | TrackContextOutput
  | CompactTrackContextOutput
  | MultiSeedContextOutput
  | CompactMultiSeedContextOutput
  | SelectaError
> {
  const parsed = parseInput(GetTrackContextInput, raw);

  if (!parsed.ok) return parsed.error;

  const { track_id, seed_ids } = parsed.data;

  if ((track_id == null) === (seed_ids == null)) {
    return validationError('provide exactly one of track_id / seed_ids');
  }

  try {
    const compact = parsed.data.compact === true;
    const context = deps.cache().contextSnapshot({
      seedIds: seed_ids ?? [track_id!],
      singleSeed: seed_ids == null,
      filters: {
        excludePlaylistIds: parsed.data.exclude_playlist_ids,
        maxPlaylistTracks: parsed.data.max_playlist_tracks,
      },
      sameArtistLimit: SAME_ARTIST_CAP,
      coOccurrenceLimit: seed_ids == null ? CO_OCCURRENCE_CAP : MULTI_CO_OCCURRENCE_CAP,
      playHistoryLimit: PLAY_HISTORY_CAP,
    });

    if (context.kind === 'invalid_playlists') {
      if (context.missingIds.length > 0) {
        return validationError(
          `exclude_playlist_ids not in the cache: ${summarizeIds(context.missingIds)}. Use IDs from list_playlists; if the library changed, run refresh_library.`,
        );
      }

      return validationError(
        `exclude_playlist_ids must name user playlists: ${summarizeIds(context.nonUserIds)}. Smart, subscription, folder, and special playlists never contribute to co-occurrence.`,
      );
    }

    if (context.kind === 'missing_tracks') {
      if (seed_ids != null) return trackNotFoundError(context.missingIds);

      return {
        error: 'track_not_found',
        hint: `No track with persistent ID ${track_id} in the cache. Cache may be stale — try refresh_library.`,
      };
    }

    if (seed_ids != null) return multiSeedContext(context, compact);

    const { sameArtist, coOccurrence, cacheAgeHours } = context;
    const seed = context.seeds[0]!;
    const common = {
      play_history: context.playHistory.map((w) => ({
        at: w.refreshedAt,
        plays: w.playCountDelta,
        skips: w.skipCountDelta,
      })),
      appearing_in_playlists: context.appearingInPlaylists,
      source_playlists: coOccurrence.sourcePlaylists,
      cache_age_hours: roundCacheAge(cacheAgeHours),
    };

    if (compact) {
      const legend = playlistLegend(coOccurrence.tracks);

      return {
        ...common,
        track_fields: COMPACT_TRACK_FIELDS,
        seed: projectApiTrack(seed, true),
        same_artist: sameArtist.map((row) => projectApiTrack(row, true)),
        co_occurring_tracks: coOccurrence.tracks.map((track, index) => ({
          track: projectApiTrack(track, true),
          shared_playlist_count: track.totalSharedPlaylistCount,
          playlist_refs: legend.refs[index]!,
        })),
        playlist_legend: legend.entries,
      };
    }

    return {
      ...common,
      seed: projectApiTrack(seed, false),
      same_artist: sameArtist.map((row) => projectApiTrack(row, false)),
      co_occurring_tracks: coOccurrence.tracks.map((track) => ({
        ...projectApiTrack(track, false),
        shared_playlist_count: track.totalSharedPlaylistCount,
        shared_playlist_names: track.sharedPlaylistNames,
      })),
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
