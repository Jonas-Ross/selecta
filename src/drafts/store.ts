// Personal draft state is separate from the refreshable library cache. Each
// mutation uses a SQLite transaction and an explicit compare-and-swap revision.
import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defaultDbPath } from '../cache/db.js';
import { BridgeError } from '../types/errors.js';

export const Appearance = z.enum(['host', 'copper', 'cobalt', 'ember', 'moss', 'oxblood', 'oled']);

export const Entry = z.strictObject({
  entry_id: z.string().uuid(),
  track_id: z.string().min(1),
});
export const Draft = z.strictObject({
  draft_id: z.string().uuid(),
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(300),
  entries: z.array(Entry).min(1).max(500),
  selected_entry_ids: z.array(z.string().uuid()).max(500),
  feedback: z.string().max(2000),
  save: z
    .strictObject({
      revision: z.number().int().positive(),
      status: z.enum(['pending', 'finished']),
      result: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
export type Draft = z.infer<typeof Draft>;

export class DraftStore {
  constructor(readonly path = join(dirname(defaultDbPath()), 'drafts.db')) {}

  private access<T>(write: boolean, run: (db: Database.Database) => T): T {
    let db: Database.Database | undefined;

    try {
      if (!write && !existsSync(this.path)) {
        throw new BridgeError('draft_not_found', 'Draft store does not exist.');
      }

      if (write) mkdirSync(dirname(this.path), { recursive: true });

      db = new Database(this.path, { readonly: !write });

      if (write)
        db.exec('CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, body TEXT NOT NULL)');

      return run(db);
    } catch (error) {
      if (error instanceof BridgeError) throw error;

      throw new BridgeError(
        'cache_unavailable',
        String(error),
        'Could not read or persist local drafts. Check the Selecta data directory; no automatic retry was made.',
      );
    } finally {
      db?.close();
    }
  }

  appearance(value?: z.infer<typeof Appearance>): z.infer<typeof Appearance> {
    if (value !== undefined) Appearance.parse(value);

    if (value === undefined && !existsSync(this.path)) return 'host';

    return this.access(value !== undefined, (db) => {
      if (value !== undefined) {
        db.exec(
          'CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
        );
        db.prepare(
          "INSERT INTO preferences VALUES ('appearance', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(value);

        return value;
      }

      if (
        !db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'preferences'")
          .get()
      )
        return 'host';

      const row = db.prepare("SELECT value FROM preferences WHERE key = 'appearance'").get() as
        | { value: string }
        | undefined;

      return row ? Appearance.parse(row.value) : 'host';
    });
  }

  private read(db: Database.Database, id: string): Draft {
    const row = db.prepare('SELECT body FROM drafts WHERE id = ?').get(id) as
      | { body: string }
      | undefined;

    if (!row) throw new BridgeError('draft_not_found', 'Draft not found.');

    // Retire the prototype pin field at the storage boundary. Reads preserve the
    // original file and revision; later explicit edits persist the current shape.
    const stored = Draft.extend({
      entries: z
        .array(Entry.extend({ pinned: z.boolean().optional() }))
        .min(1)
        .max(500),
    }).parse(JSON.parse(row.body));

    return Draft.parse({
      ...stored,
      entries: stored.entries.map(({ entry_id, track_id }) => ({ entry_id, track_id })),
    });
  }

  get(id: string): Draft {
    return this.access(false, (db) => this.read(db, id));
  }

  create(id: string, name: string, trackIds: string[]): Draft {
    const draft = Draft.parse({
      draft_id: id,
      revision: 1,
      name,
      entries: trackIds.map((track_id) => ({ entry_id: randomUUID(), track_id })),
      selected_entry_ids: [],
      feedback: '',
    });

    this.access(true, (db) => {
      const inserted = db
        .prepare('INSERT OR IGNORE INTO drafts VALUES (?, ?)')
        .run(draft.draft_id, JSON.stringify(draft));

      if (!inserted.changes)
        throw new BridgeError(
          'draft_revision_conflict',
          'Draft ID already exists.',
          'Use get_playlist_draft to recover this draft; do not recreate it.',
        );
    });

    return draft;
  }

  update(id: string, revision: number, change: (draft: Draft) => Draft): Draft {
    return this.access(true, (db) =>
      db
        .transaction(() => {
          const previous = this.read(db, id);

          if (previous.revision !== revision)
            throw new BridgeError(
              'draft_revision_conflict',
              'Stale draft revision.',
              `Draft ${id} is now revision ${previous.revision}. Use get_playlist_draft to recover it and reconcile your edits; do not replay the stale edit.`,
            );

          const next = Draft.parse({ ...change(previous), draft_id: id, revision: revision + 1 });

          db.prepare('UPDATE drafts SET body = ? WHERE id = ?').run(JSON.stringify(next), id);

          return next;
        })
        .immediate(),
    );
  }
}
