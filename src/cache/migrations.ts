import type Database from 'better-sqlite3';
import { SCHEMA } from './schema.js';

export type Migration = {
  version: number;
  sql: string;
};

// Historical schemas only added objects; IF NOT EXISTS brings every released
// unversioned schema to the same baseline without rewriting existing rows.
export const MIGRATIONS: readonly Migration[] = [{ version: 1, sql: SCHEMA }];

export function migrateDatabase(
  db: Database.Database,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1) {
      throw new Error('Cache migrations must have consecutive versions starting at 1');
    }
  }

  // Acquire the writer lock before reading the version: concurrent openers must
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
