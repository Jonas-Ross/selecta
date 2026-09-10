// Connection-owned query statements. Transactions belong to SelectaCache.
import type { Database, Statement } from 'better-sqlite3';
import type { RawPlaylist } from '../../types/bridge.js';
import type { PlaylistCreationRow } from '../../types/cache.js';
import type { createMetadataQueries } from './metadata.js';

export function createPlaylistsQueries(
  db: Database,
  notes: Pick<ReturnType<typeof createMetadataQueries>, 'deleteNote'>,
) {
  const upsertPlaylistStmt: Statement = db.prepare(`
    INSERT INTO playlists (persistent_id, name, kind, parent_persistent_id)
    VALUES (@persistentId, @name, @kind, @parentPersistentId)
    ON CONFLICT(persistent_id) DO UPDATE SET
      name=excluded.name, kind=excluded.kind,
      parent_persistent_id=excluded.parent_persistent_id
  `);

  const deleteMembershipStmt = db.prepare(
    'DELETE FROM playlist_tracks WHERE playlist_persistent_id = ?',
  );

  const insertMembershipStmt = db.prepare(
    'INSERT INTO playlist_tracks (playlist_persistent_id, track_persistent_id, position) VALUES (?, ?, ?)',
  );

  const recordCreationStmt = db.prepare(`
    INSERT OR REPLACE INTO playlist_creations
      (created_persistent_id, current_persistent_id, name, track_ids_json, created_at)
    VALUES (@createdId, @createdId, @name, @trackIdsJson, @createdAt)
  `);

  const creationsSinceStmt = db.prepare(`
    SELECT created_persistent_id AS createdPersistentId,
           current_persistent_id AS currentPersistentId,
           name, track_ids_json AS trackIdsJson, created_at AS createdAt
    FROM playlist_creations WHERE created_at >= ? ORDER BY created_at
  `);

  const setCreationCurrentIdStmt = db.prepare(
    'UPDATE playlist_creations SET current_persistent_id = ? WHERE created_persistent_id = ?',
  );

  const deleteCreationsByCurrentIdStmt = db.prepare(
    'DELETE FROM playlist_creations WHERE current_persistent_id = ?',
  );

  const resolveCreationStmt = db.prepare(
    'SELECT current_persistent_id AS currentId, name FROM playlist_creations WHERE created_persistent_id = ?',
  );

  const repointCreationsByCurrentIdStmt = db.prepare(
    'UPDATE playlist_creations SET current_persistent_id = ? WHERE current_persistent_id = ?',
  );

  const deletePlaylistRowStmt = db.prepare('DELETE FROM playlists WHERE persistent_id = ?');

  return {
    upsertPlaylist(playlist: RawPlaylist): void {
      upsertPlaylistStmt.run({
        persistentId: playlist.persistentId,
        name: playlist.name,
        kind: playlist.kind,
        parentPersistentId: playlist.parentPersistentId ?? null,
      });
    },

    replacePlaylistMembership(playlistPersistentId: string, trackPersistentIds: string[]): void {
      deleteMembershipStmt.run(playlistPersistentId);
      trackPersistentIds.forEach((trackId, position) => {
        insertMembershipStmt.run(playlistPersistentId, trackId, position);
      });
    },

    recordPlaylistCreation(entry: {
      createdId: string;
      name: string;
      trackIds: string[];
      createdAt: string;
    }): void {
      recordCreationStmt.run({
        createdId: entry.createdId,
        name: entry.name,
        trackIdsJson: JSON.stringify(entry.trackIds),
        createdAt: entry.createdAt,
      });
    },

    getCreationsSince(sinceIso: string): PlaylistCreationRow[] {
      const rows = creationsSinceStmt.all(sinceIso) as (Omit<PlaylistCreationRow, 'trackIds'> & {
        trackIdsJson: string;
      })[];

      return rows.map(({ trackIdsJson, ...row }) => ({
        ...row,
        trackIds: JSON.parse(trackIdsJson) as string[],
      }));
    },

    setCreationCurrentId(createdId: string, currentId: string): void {
      setCreationCurrentIdStmt.run(currentId, createdId);
    },

    deleteCreationsByCurrentId(persistentId: string): void {
      deleteCreationsByCurrentIdStmt.run(persistentId);
    },

    resolveCreatedPlaylistId(createdId: string): string | null {
      const row = resolveCreationStmt.get(createdId) as { currentId: string } | undefined;

      return row?.currentId ?? null;
    },

    getCreationName(createdId: string): string | null {
      const row = resolveCreationStmt.get(createdId) as { name: string } | undefined;

      return row?.name ?? null;
    },

    repointCreations(fromCurrentId: string, toCurrentId: string): void {
      repointCreationsByCurrentIdStmt.run(toCurrentId, fromCurrentId);
    },

    deletePlaylistRow(persistentId: string): void {
      deletePlaylistRowStmt.run(persistentId);
      deleteMembershipStmt.run(persistentId);
      notes.deleteNote('playlist', persistentId);
    },
  };
}
