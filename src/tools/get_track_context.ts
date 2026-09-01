// get_track_context — the curatorial graph walk: seed +
// same-artist tracks + containing playlists + co-occurring tracks from the
// user's own playlists. With seed_ids, one aggregated co-occurrence view
// across the whole seed set instead of N single-seed calls.

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import type {
  CoOccurrenceFilters,
  PlaylistRef,
  SourcePlaylistAudit,
} from '../types/cache.js';
import {
  COMPACT_TRACK_FIELDS,
  missingTrackIdsError,
  parseInput,
  projectApiTrack,
  toErrorEnvelope,
  roundedCacheAge,
  validationError,
  type ApiTrack,
  type CompactApiTrack,
  type ToolDeps,
} from './common.js';

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

type ContextFiltersInput = {
  exclude_playlist_ids?: string[];
  max_playlist_tracks?: number;
};

function summarizeIds(ids: string[]): string {
  const more = ids.length > 5 ? ` (+${ids.length - 5} more)` : '';
  return `${ids.slice(0, 5).join(', ')}${more}`;
}

function resolveCoOccurrenceFilters(
  input: ContextFiltersInput,
  deps: ToolDeps,
): CoOccurrenceFilters | SelectaError {
  const cache = deps.cache();
  const requestedIds = [...new Set(input.exclude_playlist_ids ?? [])];
  const resolvedIds = requestedIds.map((id) => cache.resolvePlaylistId(id));
  const playlists = resolvedIds.map((id) => cache.getPlaylist(id));
  const missingIds = requestedIds.filter((_, i) => playlists[i] === null);
  if (missingIds.length > 0) {
    return validationError(
      `exclude_playlist_ids not in the cache: ${summarizeIds(missingIds)}. Use IDs from list_playlists; if the library changed, run refresh_library.`,
    );
  }
  const nonUserIds = requestedIds.filter((_, i) => playlists[i]!.kind !== 'user');
  if (nonUserIds.length > 0) {
    return validationError(
      `exclude_playlist_ids must name user playlists: ${summarizeIds(nonUserIds)}. Smart, subscription, folder, and special playlists never contribute to co-occurrence.`,
    );
  }
  return {
    excludePlaylistIds: [...new Set(resolvedIds)],
    maxPlaylistTracks: input.max_playlist_tracks,
  };
}

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
  seed_ids: string[],
  filters: CoOccurrenceFilters,
  compact: boolean,
  deps: ToolDeps,
): MultiSeedContextOutput | CompactMultiSeedContextOutput | SelectaError {
  const cache = deps.cache();
  const seedIds = [...new Set(seed_ids)];
  const seedRows = seedIds.map((id) => cache.getTrack(id));
  if (seedRows.includes(null)) return missingTrackIdsError(cache, seedIds)!;
  const coOccurrence = cache.getCoOccurrence(seedIds, filters, MULTI_CO_OCCURRENCE_CAP);
  const common = {
    source_playlists: coOccurrence.sourcePlaylists,
    cache_age_hours: roundedCacheAge(deps),
  };
  if (compact) {
    const legend = playlistLegend(coOccurrence.tracks);
    return {
      ...common,
      track_fields: COMPACT_TRACK_FIELDS,
      seeds: seedRows.map((row) => projectApiTrack(row!, true)),
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
    seeds: seedRows.map((row) => projectApiTrack(row!, false)),
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
    const filters = resolveCoOccurrenceFilters(parsed.data, deps);
    if ('error' in filters) return filters;
    const compact = parsed.data.compact === true;
    if (seed_ids != null) return multiSeedContext(seed_ids, filters, compact, deps);

    const cache = deps.cache();
    const seed = cache.getTrack(track_id!);
    if (!seed) {
      return {
        error: 'track_not_found',
        hint: `No track with persistent ID ${track_id} in the cache. Cache may be stale — try refresh_library.`,
      };
    }

    const sameArtist =
      seed.artist != null
        ? cache
            .getTracksByArtist(seed.artist, SAME_ARTIST_CAP + 1)
            .filter((t) => t.persistentId !== seed.persistentId)
            .slice(0, SAME_ARTIST_CAP)
        : [];

    const coOccurrence = cache.getCoOccurrence(
      [seed.persistentId],
      filters,
      CO_OCCURRENCE_CAP,
    );
    const common = {
      play_history: cache
        .getTrackPlayHistory(seed.persistentId, PLAY_HISTORY_CAP)
        .map((w) => ({ at: w.refreshedAt, plays: w.playCountDelta, skips: w.skipCountDelta })),
      appearing_in_playlists: cache.getPlaylistsContainingTrack(seed.persistentId),
      source_playlists: coOccurrence.sourcePlaylists,
      cache_age_hours: roundedCacheAge(deps),
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
