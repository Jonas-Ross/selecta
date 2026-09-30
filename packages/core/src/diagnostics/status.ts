// Side-effect-free cache diagnostics. This deliberately bypasses SelectaCache:
// its normal open path creates directories, databases, and schema. Diagnostics
// instead require an existing database and hold a read-only SQLite connection.

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { sourceForProvenance, type SourceField } from '../cache/audio_features.js';
import { LATEST_SCHEMA_VERSION } from '../cache/migrations.js';
import type { FeatureSource } from '../types/cache.js';

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
    // Null until the database opens. A nonzero `pending` means everything
    // below was measured against a shape this build has not upgraded yet.
    schema: SchemaVersions | null;
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
  // Per-source attempt counts, because a track the catalogs exhausted is still
  // pending analysis; coverage is library-wide, whichever source supplied it.
  audio_features: null | {
    sources: Record<FeatureSource, SourceCounts>;
    coverage: {
      bpm: Coverage;
      musical_key: Coverage;
      camelot: Coverage;
      danceability: Coverage;
    };
  };
};

type Coverage = { track_count: number; percent: number };

export type SchemaVersions = { version: number; expected: number; pending: number };

type SourceCounts = {
  attempted: number;
  successful: number;
  no_data: number;
  no_match: number;
  pending: number;
  // Values on the row this source supplied. Unlike `successful`, a failed
  // retry of an earlier success cannot lower it.
  owns: Owned;
};

type Owned = { bpm: number; musical_key: number; danceability: number };

const OWNED_KEYS: Record<SourceField, keyof Owned> = {
  bpm: 'bpm',
  musicalKey: 'musical_key',
  danceability: 'danceability',
};

type CountsRow = {
  trackCount: number;
  playlistCount: number;
  bpmCount: number;
  keyCount: number;
  camelotCount: number;
  danceabilityCount: number;
};

type SourceCountsRow = {
  attempted: number;
  successful: number;
  noData: number;
  noMatch: number;
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

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).some(
    (info) => info.name === column,
  );
}

function coverage(count: number, total: number): Coverage {
  return { track_count: count, percent: percent(count, total) };
}

// One source's terminal record. Pending is tracks that source has not
// attempted, which is not the same as tracks without a features row.
function sourceCounts(db: Database.Database, statusColumn: string, owns: Owned): SourceCounts {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM audio_features WHERE ${statusColumn} IS NOT NULL) AS attempted,
         (SELECT COUNT(*) FROM audio_features WHERE ${statusColumn} = 'ok') AS successful,
         (SELECT COUNT(*) FROM audio_features WHERE ${statusColumn} = 'no_data') AS noData,
         (SELECT COUNT(*) FROM audio_features WHERE ${statusColumn} = 'no_match') AS noMatch,
         (SELECT COUNT(*) FROM tracks t WHERE NOT EXISTS
            (SELECT 1 FROM audio_features af
              WHERE af.track_persistent_id = t.persistent_id
                AND af.${statusColumn} IS NOT NULL)) AS pending`,
    )
    .get() as SourceCountsRow;

  return {
    attempted: row.attempted,
    successful: row.successful,
    no_data: row.noData,
    no_match: row.noMatch,
    pending: row.pending,
    owns,
  };
}

function ownership(db: Database.Database): Record<FeatureSource, Owned> {
  const owned: Record<FeatureSource, Owned> = {
    catalog: { bpm: 0, musical_key: 0, danceability: 0 },
    analysis: { bpm: 0, musical_key: 0, danceability: 0 },
  };
  const rows = db
    .prepare(
      `SELECT je.key AS field, je.value AS provenance, COUNT(*) AS count
         FROM audio_features af, json_each(af.sources) je
        WHERE json_valid(af.sources)
        GROUP BY je.key, je.value`,
    )
    .all() as { field: string; provenance: unknown; count: number }[];

  for (const row of rows) {
    if (!Object.hasOwn(OWNED_KEYS, row.field) || typeof row.provenance !== 'string') continue;

    owned[sourceForProvenance(row.provenance)][OWNED_KEYS[row.field as SourceField]] += row.count;
  }

  return owned;
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
    schema: null as SchemaVersions | null,
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

    const installed = db.pragma('user_version', { simple: true }) as number;

    database.schema = {
      version: installed,
      expected: LATEST_SCHEMA_VERSION,
      pending: Math.max(LATEST_SCHEMA_VERSION - installed, 0),
    };

    const perSource = hasColumn(db, 'audio_features', 'catalog_status');
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM tracks) AS trackCount,
           (SELECT COUNT(*) FROM playlists) AS playlistCount,
           (SELECT COUNT(*) FROM tracks t LEFT JOIN audio_features af
              ON af.track_persistent_id = t.persistent_id
              WHERE COALESCE(af.bpm, t.bpm) IS NOT NULL) AS bpmCount,
           (SELECT COUNT(*) FROM audio_features WHERE musical_key IS NOT NULL) AS keyCount,
           ${perSource ? '(SELECT COUNT(*) FROM audio_features WHERE camelot IS NOT NULL)' : '0'} AS camelotCount,
           (SELECT COUNT(*) FROM audio_features WHERE danceability IS NOT NULL) AS danceabilityCount`,
      )
      .get() as CountsRow;
    const owned = ownership(db);
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
        sources: {
          // Before migration 3 every row is a catalog attempt, which is what
          // that migration backfills; diagnostics never migrate, so read the
          // old shape rather than failing on a database a build hasn't opened.
          catalog: sourceCounts(db, perSource ? 'catalog_status' : 'status', owned.catalog),
          analysis: perSource
            ? sourceCounts(db, 'analysis_status', owned.analysis)
            : {
                attempted: 0,
                successful: 0,
                no_data: 0,
                no_match: 0,
                pending: counts.trackCount,
                owns: owned.analysis,
              },
        },
        coverage: {
          bpm: coverage(counts.bpmCount, counts.trackCount),
          musical_key: coverage(counts.keyCount, counts.trackCount),
          camelot: coverage(counts.camelotCount, counts.trackCount),
          danceability: coverage(counts.danceabilityCount, counts.trackCount),
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
