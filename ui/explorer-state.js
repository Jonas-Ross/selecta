import { z } from 'zod';

// Tool results cross the host boundary. Validate before rendering or sending IDs.
const count = z.number().int().nonnegative();
const track = z.object({
  persistent_id: z.string().min(1),
  title: z.string().optional(),
  artist: z.string().optional(),
  album: z.string().optional(),
  year: z.number().optional(),
  genre: z.string().optional(),
  duration_seconds: z.number().positive().optional(),
  signal: z.object({
    play_count: count,
    loved: z.literal(true).optional(),
    date_added: z.string().optional(),
  }),
});
const resultSchema = z.object({
  filters: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
  ),
  sort: z.enum(['recently_added', 'least_played', 'most_played']),
  offset: count,
  limit: count.positive().max(50),
  total_matches: count,
  next_offset: count.nullable(),
  tracks: z.array(track).max(50),
  overview: z.object({
    total_tracks: count,
    total_runtime_human: z.string(),
    cache_age_hours: z.number().nullable(),
    genres: z.array(z.object({ name: z.string(), count })).max(50),
    genres_other: z.object({ distinct: count, tracks: count }).optional(),
    decades: z.array(z.object({ decade: z.string().regex(/^\d+s$/), count })).max(30),
    recent_activity: z.object({ window_days: count, total_plays: count, total_skips: count }),
  }),
  decades_other: z.object({ distinct: count, tracks: count }),
  missing: z.object({ genre: count, year: count }),
});

function toolData(result) {
  let data = result.structuredContent;

  if (!data) {
    const text = result.content?.find((item) => item.type === 'text')?.text;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(text || 'Library data is unavailable. Use Reload view.');
    }
  }

  if (result.isError || data?.error) throw new Error(data?.hint || 'Library request failed.');

  return data;
}

export function unpackRefresh(result) {
  const parsed = z
    .object({ track_count: count, playlist_count: count, refreshed_at: z.iso.datetime() })
    .safeParse(toolData(result));

  if (!parsed.success)
    throw new Error('Invalid refresh response. Use Reload view to inspect the current cache.');

  return parsed.data;
}

export function unpackExplorer(result) {
  const parsed = resultSchema.safeParse(toolData(result));

  if (!parsed.success)
    throw new Error('Invalid library response. Reconnect Selecta, then reload this view.');

  return parsed.data;
}

export const SEED_LIMIT = 50;

export function toggleSeed(selected, track) {
  const next = new Map(selected);

  if (next.has(track.persistent_id)) next.delete(track.persistent_id);
  else {
    if (next.size >= SEED_LIMIT)
      throw new Error(`Select up to ${SEED_LIMIT} seed tracks. Remove one to choose another.`);

    next.set(track.persistent_id, track);
  }

  return next;
}

export function explorerContext(state, selected) {
  return {
    filters: state.filters,
    total_matches: state.total_matches,
    cache_age_hours: state.overview.cache_age_hours,
    selected_track_ids: [...selected.keys()],
    selection_scope: selected.size ? 'selected_seeds' : 'filtered_slice',
  };
}

export function curationMessage(state, selected, request) {
  if (!request.trim()) throw new Error('Describe what you would like the agent to make.');

  return `Please propose a playlist from my owned library using this request: ${request.trim()}\nLibrary explorer context: ${JSON.stringify(explorerContext(state, selected))}\nSelected IDs are seeds, not an ordered playlist or a request to write to Music.app. If no IDs are selected, use the filters to explore the full slice; the visible page is not the whole slice.`;
}

export function decadeFilters(filters, decade) {
  const year = Number.parseInt(decade, 10);
  const next = { ...filters };

  if (next.year_min === year && next.year_max === year + 9) {
    delete next.year_min;
    delete next.year_max;
  } else {
    next.year_min = year;
    next.year_max = year + 9;
  }

  return next;
}
