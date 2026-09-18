import type Database from 'better-sqlite3';
import { SCHEMA } from './schema.js';

export type Migration = {
  version: number;
  sql: string;
};

// Historical schemas only added objects; IF NOT EXISTS brings every released
// unversioned schema to the same baseline without rewriting existing rows.
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: SCHEMA },
  // Marks a receipt whose rekey landed on a pre-existing playlist (the same
  // collision movePlaylistNote guards for notes) so edit tools can refuse
  // instead of silently writing to the wrong playlist. No backfill: existing
  // receipts default to unconflicted, since no prior rekey is known to have
  // collided.
  {
    version: 2,
    sql: 'ALTER TABLE playlist_creations ADD COLUMN edit_conflict INTEGER NOT NULL DEFAULT 0;',
  },
  // Audio analysis (metrognome) joins the catalog sources, so "attempted"
  // becomes per-source: a track the catalogs had nothing for is still worth
  // analyzing. Estimates gain the confidence and maturity their source
  // reports, so a hint is never stored as a measurement. The one UPDATE fills
  // the column it just added and rewrites nothing that existed before.
  {
    version: 3,
    sql: `
      ALTER TABLE audio_features ADD COLUMN camelot TEXT;
      ALTER TABLE audio_features ADD COLUMN bpm_confidence REAL;
      ALTER TABLE audio_features ADD COLUMN bpm_maturity TEXT;
      ALTER TABLE audio_features ADD COLUMN key_confidence REAL;
      ALTER TABLE audio_features ADD COLUMN key_maturity TEXT;
      ALTER TABLE audio_features ADD COLUMN catalog_status TEXT;
      ALTER TABLE audio_features ADD COLUMN analysis_status TEXT;
      UPDATE audio_features SET catalog_status = status;
    `,
  },
];

export function migrateDatabase(
  db: Database.Database,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1) {
      throw new Error('Cache migrations must have consecutive versions starting at 1');
    }
  }

  // A current schema needs no writer lock: startup must still work while another
  // process writes the cache, so it can reach the operation lock when needed.
  if (db.pragma('user_version', { simple: true }) === migrations.length) return;

  // Acquire the writer lock before re-reading the version: concurrent openers must
  // observe the version committed by the previous writer, not run its work twice.
  // One transaction covers the whole upgrade, including every version update.
  db.transaction(() => {
    const installed = db.pragma('user_version', { simple: true }) as number;

    if (installed < 0 || installed > migrations.length) {
      throw new Error(
        `Unsupported cache schema version ${installed}; this build supports up to ${migrations.length}`,
      );
    }

    for (const migration of migrations) {
      if (migration.version <= installed) continue;

      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    }
  }).immediate();
}
