// Side-effect-free cache diagnostics. This deliberately bypasses SelectaCache:
// its normal open path creates directories, databases, and schema. Diagnostics
// instead require an existing database and hold a read-only SQLite connection.

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

type LastRefresh = {
  refreshed_at: string;
  duration_ms: number | null;
  track_count: number | null;
  playlist_count: number | null;
  notes: string | null;
};

export type ReconciliationSummary = {
  rekeys: number;
  duplicates_removed: number;
  failures: number;
};

export type StatusReport = {
  ok: boolean;
  database: {
    path: string;
    exists: boolean;
    integrity: 'ok' | 'failed' | 'unavailable';
    errors: string[];
  };
  cache: null | {
    age_hours: number | null;
    track_count: number;
    playlist_count: number;
    last_refresh: LastRefresh | null;
    last_reconciliation: null | {
      refreshed_at: string;
      summary: ReconciliationSummary;
    };
  };
  audio_features: null | {
    attempted: number;
    successful: number;
    no_data: number;
    no_match: number;
    pending: number;
    coverage: {
      bpm: { track_count: number; percent: number };
      musical_key: { track_count: number; percent: number };
      danceability: { track_count: number; percent: number };
    };
  };
};

type CountsRow = {
  trackCount: number;
  playlistCount: number;
  attempted: number;
  successful: number;
  noData: number;
  noMatch: number;
  bpmCount: number;
  keyCount: number;
  danceabilityCount: number;
  pending: number;
};

type RefreshRow = {
  refreshedAt: string;
  durationMs: number | null;
  trackCount: number | null;
  playlistCount: number | null;
  notes: string | null;
};

const RECONCILIATION_PREFIX = 'sync_reconciliation=';

export function formatReconciliationSummary(summary: ReconciliationSummary): string {
  return `${RECONCILIATION_PREFIX}${JSON.stringify(summary)}`;
}

function parseReconciliationSummary(notes: string): ReconciliationSummary | null {
  const start = notes.indexOf(RECONCILIATION_PREFIX);
  if (start < 0) return null;
  const json = notes.slice(start + RECONCILIATION_PREFIX.length).split(';', 1)[0]!;
  try {
    const value = JSON.parse(json) as Partial<ReconciliationSummary>;
    if (
      Number.isInteger(value.rekeys) &&
      Number.isInteger(value.duplicates_removed) &&
      Number.isInteger(value.failures)
    ) {
      return value as ReconciliationSummary;
    }
  } catch {
    // A malformed historical note is reported as absent, never repaired here.
  }
  return null;
}

function percent(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 1_000) / 10;
}

function lastRefresh(db: Database.Database): RefreshRow | null {
  return (
    (db
      .prepare(
        `SELECT refreshed_at AS refreshedAt, duration_ms AS durationMs,
                track_count AS trackCount, playlist_count AS playlistCount, notes
           FROM refresh_log ORDER BY refreshed_at DESC LIMIT 1`,
      )
      .get() as RefreshRow | undefined) ?? null
  );
}

function lastReconciliation(
  db: Database.Database,
): { refreshedAt: string; summary: ReconciliationSummary } | null {
  const rows = db
    .prepare(
      `SELECT refreshed_at AS refreshedAt, notes FROM refresh_log
        WHERE notes LIKE ? ORDER BY refreshed_at DESC`,
    )
    .all(`%${RECONCILIATION_PREFIX}%`) as { refreshedAt: string; notes: string }[];
  for (const row of rows) {
    const summary = parseReconciliationSummary(row.notes);
    if (summary) return { refreshedAt: row.refreshedAt, summary };
  }
  return null;
}

export function readStatus(dbPath: string, now = new Date()): StatusReport {
  const database = {
    path: dbPath,
    exists: existsSync(dbPath),
    integrity: 'unavailable' as StatusReport['database']['integrity'],
    errors: [] as string[],
  };
  const unavailable = (): StatusReport => ({
    ok: false,
    database,
    cache: null,
    audio_features: null,
  });

  if (!database.exists) {
    database.errors.push('Cache database does not exist.');
    return unavailable();
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    const checks = db.pragma('quick_check') as { quick_check: string }[];
    database.errors = checks.map((row) => row.quick_check).filter((message) => message !== 'ok');
    database.integrity = database.errors.length === 0 ? 'ok' : 'failed';
    if (database.integrity === 'failed') return unavailable();

    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM tracks) AS trackCount,
           (SELECT COUNT(*) FROM playlists) AS playlistCount,
           (SELECT COUNT(*) FROM audio_features) AS attempted,
           (SELECT COUNT(*) FROM audio_features WHERE status = 'ok') AS successful,
           (SELECT COUNT(*) FROM audio_features WHERE status = 'no_data') AS noData,
           (SELECT COUNT(*) FROM audio_features WHERE status = 'no_match') AS noMatch,
           (SELECT COUNT(*) FROM tracks t WHERE NOT EXISTS
              (SELECT 1 FROM audio_features af
                WHERE af.track_persistent_id = t.persistent_id)) AS pending,
           (SELECT COUNT(*) FROM tracks t LEFT JOIN audio_features af
              ON af.track_persistent_id = t.persistent_id
              WHERE COALESCE(af.bpm, t.bpm) IS NOT NULL) AS bpmCount,
           (SELECT COUNT(*) FROM audio_features WHERE musical_key IS NOT NULL) AS keyCount,
           (SELECT COUNT(*) FROM audio_features WHERE danceability IS NOT NULL) AS danceabilityCount`,
      )
      .get() as CountsRow;
    const refresh = lastRefresh(db);
    const reconciliation = lastReconciliation(db);
    const refreshedAtMs = refresh ? Date.parse(refresh.refreshedAt) : Number.NaN;
    const ageHours = Number.isNaN(refreshedAtMs)
      ? null
      : (now.getTime() - refreshedAtMs) / 3_600_000;

    return {
      ok: true,
      database,
      cache: {
        age_hours: ageHours,
        track_count: counts.trackCount,
        playlist_count: counts.playlistCount,
        last_refresh: refresh
          ? {
              refreshed_at: refresh.refreshedAt,
              duration_ms: refresh.durationMs,
              track_count: refresh.trackCount,
              playlist_count: refresh.playlistCount,
              notes: refresh.notes,
            }
          : null,
        last_reconciliation: reconciliation
          ? {
              refreshed_at: reconciliation.refreshedAt,
              summary: reconciliation.summary,
            }
          : null,
      },
      audio_features: {
        attempted: counts.attempted,
        successful: counts.successful,
        no_data: counts.noData,
        no_match: counts.noMatch,
        pending: counts.pending,
        coverage: {
          bpm: {
            track_count: counts.bpmCount,
            percent: percent(counts.bpmCount, counts.trackCount),
          },
          musical_key: {
            track_count: counts.keyCount,
            percent: percent(counts.keyCount, counts.trackCount),
          },
          danceability: {
            track_count: counts.danceabilityCount,
            percent: percent(counts.danceabilityCount, counts.trackCount),
          },
        },
      },
    };
  } catch (err) {
    database.errors.push(err instanceof Error ? err.message : String(err));
    return unavailable();
  } finally {
    db?.close();
  }
}
