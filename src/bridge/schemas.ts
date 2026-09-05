import { z } from 'zod';

export const id = z.string().min(1);
export const ids = z.array(id);
const count = z.number().int().nonnegative();
const rating = z.number().min(0).max(100);
const date = z.iso.datetime({ offset: true });
const kind = z.enum(['user', 'smart', 'folder', 'special', 'subscription']);
export const playlist = z.object({
  persistentId: id,
  name: z.string(),
  kind,
  parentPersistentId: id.optional(),
  trackPersistentIds: ids,
});
export const snapshot = z.object({
  capturedAt: date,
  tracks: z.array(
    z.object({
      persistentId: id,
      title: z.string().optional(),
      artist: z.string().optional(),
      albumArtist: z.string().optional(),
      album: z.string().optional(),
      genre: z.string().optional(),
      year: count.optional(),
      durationSeconds: z.number().nonnegative().optional(),
      bpm: z.number().nonnegative().optional(),
      trackNumber: count.optional(),
      discNumber: count.optional(),
      dateAdded: date.optional(),
      lastPlayed: date.optional(),
      playCount: count.optional(),
      skipCount: count.optional(),
      rating: rating.optional(),
      loved: z.boolean().optional(),
      disliked: z.boolean().optional(),
      comments: z.string().optional(),
      locationKind: z.enum(['local', 'cloud', 'missing']).optional(),
    }),
  ),
  playlists: z.array(playlist),
});
const missing = z.object({ missingTrackIds: ids.min(1) });
const notFound = z.object({ playlistNotFound: z.literal(true) });
const notEditable = z.object({ notEditable: z.literal(true) });
export const partialWriteResult = z.object({
  partialWrite: z.object({ persistentId: id, trackPersistentIds: ids.optional() }),
});
export const writeSuccess = z.object({
  persistentId: id,
  trackCount: count,
  trackPersistentIds: ids,
});
const consistentCount = (v: z.infer<typeof writeSuccess>) =>
  v.trackCount === v.trackPersistentIds.length;
export const write = z.union([
  missing,
  partialWriteResult,
  writeSuccess.refine(consistentCount, { path: ['trackCount'] }),
]);
export const replace = z.union([
  missing,
  partialWriteResult,
  z.object({ ambiguousPreview: z.literal(true) }),
  writeSuccess.extend({ created: z.boolean() }).refine(consistentCount, { path: ['trackCount'] }),
]);
export const clone = z.union([
  partialWriteResult,
  missing,
  notFound,
  z.object({ ambiguousSource: z.object({ name: z.string(), persistentIds: ids.min(2) }) }),
  z.object({ sourceNotUser: z.literal(true), sourceKind: kind }),
  z.object({ invalidSourceTrackCount: count }),
  writeSuccess
    .extend({ sourcePersistentId: id, sourceName: z.string(), sourceTrackPersistentIds: ids })
    .refine(consistentCount, { path: ['trackCount'] }),
]);
export const edit = z.union([
  missing,
  notFound,
  notEditable,
  z.object({ invalidPositions: z.array(count).min(1), liveTrackCount: count }),
  z.object({ orderDrifted: z.literal(true), liveTrackCount: count }),
  z.object({ invalidOrder: z.literal(true), liveTrackCount: count }),
  writeSuccess
    .extend({
      trackPersistentIds: ids,
      preEditTrackPersistentIds: ids,
      removedCount: count.optional(),
      movedCount: count.optional(),
    })
    .refine((v) => v.trackCount === v.trackPersistentIds.length, { path: ['trackCount'] }),
]);
const loved = z.object({ persistentId: id, loved: z.boolean() });
const rated = z.object({ persistentId: id, rating: rating.nullable() });
export const lovedResult = z.union([
  missing,
  z.object({ tracks: z.array(loved), preWriteTracks: z.array(loved) }),
]);
export const ratingResult = z.union([
  missing,
  z.object({ tracks: z.array(rated), preWriteTracks: z.array(rated) }),
]);
export const deleted = z.union([notEditable, z.object({ deleted: count.max(100) })]);
export const namedPlaylists = z.array(z.object({ persistentId: id, trackCount: count }));
export const diagnostic = z.object({
  running: z.literal(true),
  automationAuthorized: z.literal(true),
});
