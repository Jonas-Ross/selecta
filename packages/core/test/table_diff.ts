// Snapshot every cache table, run something, and state the whole delta.
//
// The guardrail this exists for: a destructive command's own summary must
// account for every row that moved. A test asserting only the intended change
// stays green when a command quietly touches something else — which is exactly
// how a source's values were once cleared without anything reporting it.

import type { Database } from 'better-sqlite3';
import { expect } from 'vitest';

export type TableSnapshot = Map<string, Record<string, unknown>>;
export type CacheSnapshot = Map<string, TableSnapshot>;

export type RowChange = {
  table: string;
  key: string;
  change: 'added' | 'removed' | 'changed';
  // Columns whose value differs; only on 'changed'.
  fields?: string[];
};

// FTS5 keeps its own shadow tables in sync with tracks; they are storage, not
// state a command is answerable for.
function userTables(db: Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'
         ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

function primaryKey(db: Database, table: string): string[] {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    pk: number;
  }[];
  const keyed = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);

  return keyed.length > 0
    ? keyed.map((column) => column.name)
    : columns.map((column) => column.name);
}

export function snapshotCache(db: Database): CacheSnapshot {
  const snapshot: CacheSnapshot = new Map();

  for (const table of userTables(db)) {
    const key = primaryKey(db, table);
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];

    snapshot.set(
      table,
      new Map(rows.map((row) => [key.map((c) => String(row[c])).join('|'), row])),
    );
  }

  return snapshot;
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => before[field] !== after[field])
    .sort();
}

/** Every row that differs between two snapshots, in a stable order. */
export function diffCache(before: CacheSnapshot, after: CacheSnapshot): RowChange[] {
  const changes: RowChange[] = [];

  for (const [table, afterRows] of after) {
    const beforeRows = before.get(table) ?? new Map();

    for (const [key, afterRow] of afterRows) {
      const beforeRow = beforeRows.get(key);

      if (beforeRow == null) {
        changes.push({ table, key, change: 'added' });
        continue;
      }

      const fields = changedFields(beforeRow, afterRow);

      if (fields.length > 0) changes.push({ table, key, change: 'changed', fields });
    }

    for (const key of beforeRows.keys()) {
      if (!afterRows.has(key)) changes.push({ table, key, change: 'removed' });
    }
  }

  return changes.sort((a, b) => `${a.table}|${a.key}`.localeCompare(`${b.table}|${b.key}`));
}

/**
 * Assert the database moved in exactly these ways and no others.
 *
 * Pass an empty list to assert byte-identical: that is the dry-run test every
 * destructive command owes (docs/destructive-commands.md).
 */
export function expectOnlyChanged(
  before: CacheSnapshot,
  after: CacheSnapshot,
  expected: RowChange[],
): void {
  const sorted = [...expected].sort((a, b) =>
    `${a.table}|${a.key}`.localeCompare(`${b.table}|${b.key}`),
  );

  expect(diffCache(before, after)).toEqual(sorted);
}
