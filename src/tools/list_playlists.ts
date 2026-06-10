// list_playlists — enumerate cached playlists, optionally filtered.

import { z } from 'zod';
import type { SelectaError } from '../types/errors.js';
import { toErrorEnvelope, validationError, roundedCacheAge, type ToolDeps } from './common.js';

export const listPlaylistsInputShape = {
  kind: z
    .enum(['user', 'smart', 'folder', 'subscription'])
    .optional()
    .describe('user = hand-made; smart = rule-based; subscription = Apple Music playlists the user added; folder = grouping only.'),
  name_query: z.string().optional().describe('Case-insensitive substring match on the name.'),
};

const ListPlaylistsInput = z.strictObject(listPlaylistsInputShape);

export type ListPlaylistsOutput = {
  playlists: {
    id: string;
    name: string;
    kind: string;
    track_count: number;
    parent_id?: string;
  }[];
  cache_age_hours: number | null;
};

export const LIST_PLAYLISTS_DESCRIPTION = `List the user's playlists from the cache. kind 'user' playlists are hand-made — the strongest taste signal; 'smart' and 'subscription' are rule- or Apple-generated. Use a playlist's id with search's in_playlist filter to see its tracks. Empty array = no playlists match the filter.`;

export async function handleListPlaylists(
  raw: unknown,
  deps: ToolDeps,
): Promise<ListPlaylistsOutput | SelectaError> {
  const parsed = ListPlaylistsInput.safeParse(raw);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }

  try {
    const rows = deps.cache().listPlaylists({
      kind: parsed.data.kind,
      nameQuery: parsed.data.name_query,
    });
    return {
      playlists: rows.map((p) => ({
        id: p.persistentId,
        name: p.name,
        kind: p.kind,
        track_count: p.trackCount,
        parent_id: p.parentPersistentId ?? undefined,
      })),
      cache_age_hours: roundedCacheAge(deps),
    };
  } catch (err) {
    return toErrorEnvelope(err);
  }
}
