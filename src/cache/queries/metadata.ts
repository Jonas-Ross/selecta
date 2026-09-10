// Connection-owned query statements. Transactions belong to SelectaCache.
import type { Database } from 'better-sqlite3';
import type { AudioFeaturesRow, PendingTrack, NoteRow, NoteSubject } from '../../types/cache.js';

export function createMetadataQueries(db: Database) {
  // One note per subject: an existing row keeps its created_at and takes the
  // new body and updated_at.
  const NOTE_COLUMNS = `
    subject_kind AS subjectKind, subject_id AS subjectId, body,
    created_at AS createdAt, updated_at AS updatedAt
  `;

  const upsertNoteStmt = db.prepare(`
    INSERT INTO notes (subject_kind, subject_id, body, created_at, updated_at)
    VALUES (@subjectKind, @subjectId, @body, @now, @now)
    ON CONFLICT (subject_kind, subject_id)
    DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at
    RETURNING ${NOTE_COLUMNS}
  `);

  const deleteNoteStmt = db.prepare('DELETE FROM notes WHERE subject_kind = ? AND subject_id = ?');

  const getNoteStmt = db.prepare(
    `SELECT ${NOTE_COLUMNS} FROM notes WHERE subject_kind = ? AND subject_id = ?`,
  );

  // OR REPLACE: if the destination somehow already carries a note, the moving
  // one wins — both describe the same playlist, and the alternative is a PK
  // failure mid-reconciliation.
  const movePlaylistNoteStmt = db.prepare(
    `UPDATE OR REPLACE notes SET subject_id = ? WHERE subject_kind = 'playlist' AND subject_id = ?`,
  );

  const upsertAudioFeaturesStmt = db.prepare(`
    INSERT OR REPLACE INTO audio_features
      (track_persistent_id, bpm, musical_key, danceability, sources,
       mb_recording_mbid, deezer_track_id, status, fetched_at)
    VALUES (@trackPersistentId, @bpm, @musicalKey, @danceability, @sources,
            @mbRecordingMbid, @deezerTrackId, @status, @fetchedAt)
  `);

  const getAudioFeaturesStmt = db.prepare(`
    SELECT track_persistent_id AS trackPersistentId, bpm,
           musical_key AS musicalKey, danceability, sources,
           mb_recording_mbid AS mbRecordingMbid, deezer_track_id AS deezerTrackId,
           status, fetched_at AS fetchedAt
    FROM audio_features WHERE track_persistent_id = ?
  `);

  // The enrichment backlog: tracks never attempted (no row — attempted tracks
  // are terminal whatever their status). Most-played first, so the tracks the
  // model touches most gain features earliest; stable ID tiebreak. Slim
  // projection: only what matching needs, not TRACK_COLUMNS (whose feature
  // subqueries are NULL by construction here).
  const pendingEnrichmentSql = `
    FROM tracks t
    WHERE NOT EXISTS (SELECT 1 FROM audio_features af WHERE af.track_persistent_id = t.persistent_id)
  `;

  const pendingEnrichmentStmt = db.prepare(`
    SELECT t.persistent_id AS persistentId, t.title, t.artist,
           t.duration_seconds AS durationSeconds
    ${pendingEnrichmentSql}
    ORDER BY t.play_count DESC, t.persistent_id LIMIT ?
  `);

  const countPendingEnrichmentStmt = db.prepare(`SELECT COUNT(*) AS n ${pendingEnrichmentSql}`);

  const getSourceCooldownStmt = db.prepare(
    'SELECT until_ms FROM enrichment_cooldowns WHERE host = ?',
  );
  const setSourceCooldownStmt = db.prepare(
    'INSERT INTO enrichment_cooldowns (host, until_ms) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET until_ms = MAX(until_ms, excluded.until_ms)',
  );

  return {
    getSourceCooldown(host: string): number | null {
      const row = getSourceCooldownStmt.get(host) as { until_ms: number } | undefined;

      return row?.until_ms ?? null;
    },

    setSourceCooldown(host: string, until: number): void {
      setSourceCooldownStmt.run(host, until);
    },

    upsertAudioFeatures(row: AudioFeaturesRow): void {
      upsertAudioFeaturesStmt.run({
        ...row,
        sources: row.sources != null ? JSON.stringify(row.sources) : null,
      });
    },

    getTracksPendingEnrichment(limit: number): PendingTrack[] {
      // Clamp: a negative LIMIT means "unlimited" to SQLite — a caller bug
      // must not turn a bounded batch into a full-library crawl.
      return pendingEnrichmentStmt.all(Math.max(0, limit)) as PendingTrack[];
    },

    countPendingEnrichment(): number {
      return (countPendingEnrichmentStmt.get() as { n: number }).n;
    },

    getAudioFeatures(trackPersistentId: string): AudioFeaturesRow | null {
      const row = getAudioFeaturesStmt.get(trackPersistentId) as
        | (Omit<AudioFeaturesRow, 'sources'> & { sources: string | null })
        | undefined;

      if (!row) return null;

      return {
        ...row,
        sources:
          row.sources != null ? (JSON.parse(row.sources) as AudioFeaturesRow['sources']) : null,
      };
    },

    upsertNote(subjectKind: NoteSubject, subjectId: string, body: string, now: string): NoteRow {
      return upsertNoteStmt.get({ subjectKind, subjectId, body, now }) as NoteRow;
    },

    deleteNote(subjectKind: NoteSubject, subjectId: string): void {
      deleteNoteStmt.run(subjectKind, subjectId);
    },

    getNote(subjectKind: NoteSubject, subjectId: string): NoteRow | null {
      return (getNoteStmt.get(subjectKind, subjectId) as NoteRow | undefined) ?? null;
    },

    /** Re-key a playlist note when reconciliation moves the playlist's canonical ID. */
    movePlaylistNote(fromId: string, toId: string): void {
      if (fromId !== toId) movePlaylistNoteStmt.run(toId, fromId);
    },
  };
}
