// Connection-owned query statements. Transactions belong to SelectaCache.
import type { Database, Statement } from 'better-sqlite3';
import type {
  AudioFeaturesRow,
  FeatureSource,
  NoteMoveOutcome,
  NoteRow,
  NoteSubject,
  PendingTrack,
} from '../../types/cache.js';

export type FeatureProvenanceRow = {
  field: string;
  provenance: string;
  trackCount: number;
};

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

  // The destination's note wins: a rekey can land on the user's own older
  // same-name copy, so the two notes need not describe the same playlist.
  // NOT EXISTS rather than OR IGNORE, so other violations stay loud.
  const movePlaylistNoteStmt = db.prepare(`
    UPDATE notes SET subject_id = @toId
    WHERE subject_kind = 'playlist' AND subject_id = @fromId
      AND NOT EXISTS (
        SELECT 1 FROM notes WHERE subject_kind = 'playlist' AND subject_id = @toId
      )
  `);

  const hasPlaylistNoteStmt = db.prepare(
    `SELECT 1 FROM notes WHERE subject_kind = 'playlist' AND subject_id = ? LIMIT 1`,
  );

  const upsertAudioFeaturesStmt = db.prepare(`
    INSERT OR REPLACE INTO audio_features
      (track_persistent_id, bpm, bpm_confidence, bpm_maturity, musical_key,
       camelot, key_confidence, key_maturity, danceability, sources,
       mb_recording_mbid, deezer_track_id, status, catalog_status,
       analysis_status, fetched_at)
    VALUES (@trackPersistentId, @bpm, @bpmConfidence, @bpmMaturity, @musicalKey,
            @camelot, @keyConfidence, @keyMaturity, @danceability, @sources,
            @mbRecordingMbid, @deezerTrackId, @status, @catalogStatus,
            @analysisStatus, @fetchedAt)
  `);

  const getAudioFeaturesStmt = db.prepare(`
    SELECT track_persistent_id AS trackPersistentId, bpm,
           bpm_confidence AS bpmConfidence, bpm_maturity AS bpmMaturity,
           musical_key AS musicalKey, camelot, key_confidence AS keyConfidence,
           key_maturity AS keyMaturity, danceability, sources,
           mb_recording_mbid AS mbRecordingMbid, deezer_track_id AS deezerTrackId,
           status, catalog_status AS catalogStatus, analysis_status AS analysisStatus,
           fetched_at AS fetchedAt
    FROM audio_features WHERE track_persistent_id = ?
  `);

  // The backlog for one source: tracks that source has not attempted yet.
  // Terminal is per source, so a track the catalogs had nothing for is still
  // pending analysis. Most-played first, so the tracks the model touches most
  // gain features earliest; stable ID tiebreak. Slim projection: only what
  // matching needs, not TRACK_COLUMNS (whose feature subqueries are NULL by
  // construction here).
  const pendingFor = (statusColumn: string): { page: Statement; count: Statement } => {
    const scope = `
      FROM tracks t
      WHERE NOT EXISTS (
        SELECT 1 FROM audio_features af
        WHERE af.track_persistent_id = t.persistent_id AND af.${statusColumn} IS NOT NULL
      )
    `;

    return {
      page: db.prepare(`
        SELECT t.persistent_id AS persistentId, t.title, t.artist,
               t.duration_seconds AS durationSeconds
        ${scope}
        ORDER BY t.play_count DESC, t.persistent_id LIMIT ?
      `),
      count: db.prepare(`SELECT COUNT(*) AS n ${scope}`),
    };
  };

  const pendingStmts: Record<FeatureSource, ReturnType<typeof pendingFor>> = {
    catalog: pendingFor('catalog_status'),
    analysis: pendingFor('analysis_status'),
  };

  // What produced each stored value, counted per field. Provenance lives in
  // the sources JSON rather than a column, so this is the only way to see which
  // algorithm versions a library is actually carrying. json_extract raises on
  // malformed JSON, and this is the read-only survey, so one odd row must not
  // take it down.
  const provenanceStmt = db.prepare(`
    SELECT field, provenance, COUNT(*) AS trackCount FROM (
      SELECT 'bpm' AS field, json_extract(sources, '$.bpm') AS provenance
        FROM audio_features WHERE bpm IS NOT NULL AND json_valid(sources)
      UNION ALL
      SELECT 'musicalKey', json_extract(sources, '$.musicalKey')
        FROM audio_features WHERE musical_key IS NOT NULL AND json_valid(sources)
      UNION ALL
      SELECT 'danceability', json_extract(sources, '$.danceability')
        FROM audio_features WHERE danceability IS NOT NULL AND json_valid(sources)
    )
    WHERE provenance IS NOT NULL
    GROUP BY field, provenance
    ORDER BY trackCount DESC, provenance
  `);

  // Rows carrying any of the named provenance values. The caller decides what
  // that means for each row (see supersedeFeatures).
  const rowsByProvenanceStmt = (provenances: readonly string[]): Statement =>
    db.prepare(`
      SELECT track_persistent_id AS trackPersistentId FROM audio_features
      -- json_each raises on malformed JSON, and most rows are an attempt with
      -- no sources at all, so the guard keeps one odd row from failing the run.
      WHERE json_valid(sources) AND EXISTS (
        SELECT 1 FROM json_each(audio_features.sources)
        WHERE json_each.value IN (${provenances.map(() => '?').join(', ')})
      )
      ORDER BY track_persistent_id
    `);

  const deleteAudioFeaturesStmt = db.prepare(
    'DELETE FROM audio_features WHERE track_persistent_id = ?',
  );

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

    /** Distinct provenance values across stored features, with track counts. */
    featureProvenance(): FeatureProvenanceRow[] {
      return provenanceStmt.all() as FeatureProvenanceRow[];
    },

    /** IDs of rows whose sources name any of these provenance values. */
    trackIdsWithProvenance(provenances: readonly string[]): string[] {
      if (provenances.length === 0) return [];

      return (
        rowsByProvenanceStmt(provenances).all(...provenances) as {
          trackPersistentId: string;
        }[]
      ).map((row) => row.trackPersistentId);
    },

    deleteAudioFeatures(trackPersistentId: string): void {
      deleteAudioFeaturesStmt.run(trackPersistentId);
    },

    getTracksPendingEnrichment(source: FeatureSource, limit: number): PendingTrack[] {
      // Clamp: a negative LIMIT means "unlimited" to SQLite — a caller bug
      // must not turn a bounded batch into a full-library crawl.
      return pendingStmts[source].page.all(Math.max(0, limit)) as PendingTrack[];
    },

    countPendingEnrichment(source: FeatureSource): number {
      return (pendingStmts[source].count.get() as { n: number }).n;
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
    movePlaylistNote(fromId: string, toId: string): NoteMoveOutcome {
      if (fromId !== toId && movePlaylistNoteStmt.run({ fromId, toId }).changes > 0) return 'moved';

      // Only the refused path pays for a second read.
      if (fromId === toId || hasPlaylistNoteStmt.get(fromId) === undefined)
        return 'nothing_to_move';

      return 'destination_kept';
    },
  };
}
