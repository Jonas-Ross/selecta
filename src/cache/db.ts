// SQLite handle. Opens (creating the directory and schema if needed) and maps
// open failures to the cache_unavailable error code. ':memory:' is the test path.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { BridgeError } from '../types/errors.js';
import { migrateDatabase } from './migrations.js';

export function defaultDbPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'Selecta', 'library.db');
}

export function openDatabase(path: string = defaultDbPath()): Database.Database {
  let db: Database.Database | undefined;

  try {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }

    db = new Database(path);

    migrateDatabase(db);
    db.pragma('journal_mode = WAL');

    return db;
  } catch (err) {
    db?.close();
    throw new BridgeError(
      'cache_unavailable',
      `Could not open cache at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
