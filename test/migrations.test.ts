import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/cache/db.js';
import { migrateDatabase, MIGRATIONS } from '../src/cache/migrations.js';
import { readStatus } from '../src/diagnostics/status.js';

const directories: string[] = [];
const connections: Database.Database[] = [];

function diskPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'selecta-migrations-'));

  directories.push(directory);

  return join(directory, 'library.db');
}

function track(db: Database.Database): Database.Database {
  connections.push(db);

  return db;
}

function schema(db: Database.Database): unknown {
  return db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name').all();
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name);
}

function seed(db: Database.Database): void {
  db.exec(`
    INSERT INTO tracks (rowid, persistent_id, title, artist, play_count) VALUES (42, 'T1', 'Song', 'Artist', 8);
    INSERT INTO playlists VALUES ('P1', 'Playlist', 'user', NULL);
    INSERT INTO playlist_tracks VALUES ('P1', 'T1', 1), ('P1', 'T1', 2);
    INSERT INTO refresh_log VALUES ('2026-09-01T00:00:00.000Z', 10, 1, 1, 'refresh note');
    INSERT INTO tracks_fts(tracks_fts) VALUES ('rebuild');
  `);
  const optional: Record<string, string> = {
    playlist_creations:
      "INSERT INTO playlist_creations VALUES ('OLD', 'P1', 'Playlist', '[\"T1\",\"T1\"]', '2026-09-01')",
    audio_features:
      "INSERT INTO audio_features VALUES ('T1', 123.5, 'Am', 0.8, '{}', 'mbid', 12, 'ok', '2026-09-01')",
    play_history: "INSERT INTO play_history VALUES ('T1', '2026-09-01', 2, 1)",
    notes:
      "INSERT INTO notes VALUES ('track', 'T1', 'verbatim note', '2026-09-01', '2026-09-01'), ('playlist', 'P1', 'playlist note', '2026-09-01', '2026-09-01')",
    enrichment_cooldowns:
      "INSERT INTO enrichment_cooldowns VALUES ('musicbrainz.org', 9999999999999)",
  };

  for (const [table, sql] of Object.entries(optional)) {
    if (tableExists(db, table)) db.exec(sql);
  }
}

function rows(db: Database.Database): Record<string, unknown> {
  const names = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];

  return Object.fromEntries(
    names.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY 1`).all()]),
  );
}

afterEach(() => {
  vi.restoreAllMocks();

  for (const db of connections.splice(0)) if (db.open) db.close();

  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('cache schema migrations', () => {
  it('creates identical memory and disk schemas and safely reopens', () => {
    const memory = track(openDatabase(':memory:'));
    const path = diskPath();
    const disk = track(openDatabase(path));

    expect(schema(disk)).toEqual(schema(memory));
    expect(disk.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    disk.close();
    const reopened = track(openDatabase(path));

    expect(schema(reopened)).toEqual(schema(memory));
    expect(reopened.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  });

  it.each(['v0-initial', 'v0-notes', 'v0-current'])(
    'upgrades %s without rewriting any existing rows or FTS',
    (fixture) => {
      const path = diskPath();
      const old = track(new Database(path));

      old.exec(readFileSync(new URL(`./fixtures/schemas/${fixture}.sql`, import.meta.url), 'utf8'));
      seed(old);
      const before = rows(old);

      expect(old.pragma('user_version', { simple: true })).toBe(0);
      old.close();

      const upgraded = track(openDatabase(path));

      expect(upgraded.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
      const after = rows(upgraded);

      for (const [name, data] of Object.entries(before)) expect(after[name], name).toEqual(data);

      expect(schema(upgraded)).toEqual(schema(track(openDatabase(':memory:'))));
      expect(
        upgraded.prepare("SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH 'Song'").all(),
      ).toEqual([{ rowid: 42 }]);
      upgraded.close();
      expect(rows(track(openDatabase(path)))).toEqual(after);
    },
  );

  it('runs consecutive pending migrations once, in order, across reopen', () => {
    const path = diskPath();
    const db = track(openDatabase(path));
    const migrations = [
      ...MIGRATIONS,
      {
        version: 2,
        sql: "CREATE TABLE sequence (value TEXT); INSERT INTO sequence VALUES ('two');",
      },
      {
        version: 3,
        sql: "ALTER TABLE sequence ADD COLUMN completed INTEGER; UPDATE sequence SET value = value || '-three', completed = 1;",
      },
    ];

    migrateDatabase(db, migrations);
    db.close();
    const reopened = track(new Database(path));

    migrateDatabase(reopened, migrations);
    expect(reopened.pragma('user_version', { simple: true })).toBe(3);
    expect(reopened.prepare('SELECT * FROM sequence').all()).toEqual([
      { value: 'two-three', completed: 1 },
    ]);
  });

  it.each([2, 3])(
    'rechecks a concurrent upgrade to version %i after preflight',
    (concurrentVersion) => {
      const path = diskPath();
      const db = track(openDatabase(path));
      const other = track(new Database(path));
      const supported = [
        ...MIGRATIONS,
        {
          version: 2,
          sql: "CREATE TABLE upgrade_receipt (value); INSERT INTO upgrade_receipt VALUES ('once');",
        },
      ];
      const concurrent =
        concurrentVersion === 2
          ? supported
          : [...supported, { version: 3, sql: 'CREATE TABLE future_schema (id);' }];
      const pragma = db.pragma.bind(db);

      // Deterministically interleave a real commit on a second connection between
      // the first opener's unlocked read and its acquisition of the writer lock.
      vi.spyOn(db, 'pragma').mockImplementationOnce((source, options) => {
        const installed = pragma(source, options);

        expect(db.inTransaction).toBe(false);
        expect(installed).toBe(1);
        migrateDatabase(other, concurrent);

        return installed;
      });

      if (concurrentVersion === 2) {
        expect(() => migrateDatabase(db, supported)).not.toThrow();
      } else {
        expect(() => migrateDatabase(db, supported)).toThrow('Unsupported cache schema version 3');
      }

      expect(db.pragma('user_version', { simple: true })).toBe(concurrentVersion);
      expect(db.prepare('SELECT * FROM upgrade_receipt').all()).toEqual([{ value: 'once' }]);
    },
  );

  it('rolls back data, schema and version across all pending steps after a late failure', () => {
    const path = diskPath();
    const db = track(openDatabase(path));

    seed(db);
    const before = rows(db);
    const beforeSchema = schema(db);

    expect(() =>
      migrateDatabase(db, [
        ...MIGRATIONS,
        {
          version: 2,
          sql: "UPDATE tracks SET title = 'changed'; CREATE TABLE temporary_upgrade (id);",
        },
        { version: 3, sql: 'DROP TABLE notes; INSERT INTO missing_table VALUES (1);' },
      ]),
    ).toThrow('no such table');
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(schema(db)).toEqual(beforeSchema);
    expect(rows(db)).toEqual(before);
    db.close();
    expect(rows(track(openDatabase(path)))).toEqual(before);
  });

  it('maps baseline failures to cache_unavailable and leaves the original database usable', () => {
    const path = diskPath();
    const db = track(new Database(path));

    // An incompatible table makes index creation fail after additive DDL ran.
    db.exec("CREATE TABLE tracks (persistent_id TEXT); INSERT INTO tracks VALUES ('retained');");
    const before = schema(db);

    db.close();
    expect(() => openDatabase(path)).toThrow(
      expect.objectContaining({ errorCode: 'cache_unavailable' }),
    );
    const reopened = track(new Database(path));

    expect(schema(reopened)).toEqual(before);
    expect(reopened.pragma('user_version', { simple: true })).toBe(0);
    expect(reopened.prepare('SELECT * FROM tracks').all()).toEqual([{ persistent_id: 'retained' }]);
    reopened.exec("INSERT INTO tracks VALUES ('still writable')");
  });

  it('rejects a future schema through the normal open error without modifying it', () => {
    const path = diskPath();
    const db = track(openDatabase(path));

    seed(db);
    db.pragma('user_version = 999');
    const before = rows(db);

    db.close();
    expect(() => openDatabase(path)).toThrow(
      expect.objectContaining({
        errorCode: 'cache_unavailable',
        message: expect.stringContaining('999'),
      }),
    );
    const reopened = track(new Database(path));

    expect(rows(reopened)).toEqual(before);
    expect(reopened.pragma('user_version', { simple: true })).toBe(999);
  });

  it('rejects gaps or duplicate versions before executing SQL', () => {
    const db = track(new Database(':memory:'));

    for (const versions of [[2], [1, 1], [1, 3]]) {
      expect(() =>
        migrateDatabase(
          db,
          versions.map((version) => ({ version, sql: 'CREATE TABLE unwanted (id)' })),
        ),
      ).toThrow('consecutive');
      expect(schema(db)).toEqual([]);
    }
  });

  it('read-only diagnostics do not baseline an unversioned database', () => {
    const path = diskPath();
    const db = track(new Database(path));

    db.exec(readFileSync(new URL('./fixtures/schemas/v0-current.sql', import.meta.url), 'utf8'));
    seed(db);
    db.close();
    const before = readFileSync(path);

    expect(readStatus(path).ok).toBe(true);
    expect(readFileSync(path)).toEqual(before);
    expect(
      track(new Database(path, { readonly: true })).pragma('user_version', { simple: true }),
    ).toBe(0);
  });
});
