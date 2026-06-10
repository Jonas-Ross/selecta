// SQLite handle. Opens (creating the directory and schema if needed) and maps
// open failures to the cache_unavailable error code. ':memory:' is the test path.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { BridgeError } from '../types/errors.js';
import { SCHEMA } from './schema.js';

export function defaultDbPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'Selecta', 'library.db');
}

export function openDatabase(path: string = defaultDbPath()): Database.Database {
  try {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);
    return db;
  } catch (err) {
    throw new BridgeError(
      'cache_unavailable',
      `Could not open cache at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
