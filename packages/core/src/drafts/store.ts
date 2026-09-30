// Personal draft state is separate from the refreshable library cache. Each
// mutation uses a SQLite transaction and an explicit compare-and-swap revision.
import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defaultDbPath } from '../cache/db.js';
import { BridgeError } from '../types/errors.js';

import { PreviewState, Appearance, Entry, Draft } from './contracts.js';
export { Appearance, Entry, Draft } from './contracts.js';

/** Drafts sit next to whichever library cache the process was pointed at. */
export function draftDbPath(libraryDbPath: string = defaultDbPath()): string {
  return join(dirname(libraryDbPath), 'drafts.db');
}

export class DraftStore {
  constructor(readonly path = draftDbPath()) {}

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

  private readPreview(db: Database.Database): PreviewState | undefined {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'preview_slot'").get()) return;

    const row = db.prepare('SELECT body FROM preview_slot WHERE id = 1').get() as
      | { body: string }
      | undefined;

    return row ? PreviewState.parse(JSON.parse(row.body)) : undefined;
  }

  private writePreview(db: Database.Database, state: PreviewState): PreviewState {
    const next = PreviewState.parse({
      ...state,
      version: (this.readPreview(db)?.version ?? 0) + 1,
    });

    db.exec(
      'CREATE TABLE IF NOT EXISTS preview_slot (id INTEGER PRIMARY KEY CHECK(id = 1), body TEXT NOT NULL)',
    );
    db.prepare(
      'INSERT INTO preview_slot VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body',
    ).run(JSON.stringify(next));

    return next;
  }

  preview(): PreviewState | undefined {
    if (!existsSync(this.path)) return;

    return this.access(false, (db) => this.readPreview(db));
  }

  /** Called under the shared Music lock, before a raw replacement can start. */
  unlinkPreview(): void {
    this.access(true, (db) =>
      db
        .transaction(() => {
          this.writePreview(db, { generation: randomUUID(), version: 0, status: 'inactive' });
        })
        .immediate(),
    );
  }

  claimPreview(
    id: string,
    revision: number,
    explicit: boolean,
    expected?: string[],
  ): PreviewState | undefined {
    return this.access(true, (db) =>
      db
        .transaction(() => {
          const draft = this.read(db, id);

          if (draft.revision !== revision)
            throw new BridgeError('draft_revision_conflict', 'Stale preview request.');

          if (draft.save?.status === 'pending')
            throw new BridgeError('operation_busy', 'Permanent save is pending.');

          const previous = this.readPreview(db);
          const owned = previous?.owner === id;

          if (!explicit && (!owned || previous.status !== 'out_of_date')) return;

          if (
            explicit &&
            owned &&
            ['pending', 'conflict', 'error', 'uncertain'].includes(previous.status) &&
            expected === undefined
          )
            throw new BridgeError(
              'preview_conflict',
              'Preview requires reconciliation.',
              'Inspect Music.app and reconcile the draft, then explicitly call preview_playlist_draft with expected_track_ids matching the observed live order. Never retry blindly.',
            );

          return this.writePreview(db, {
            generation: owned ? previous.generation : randomUUID(),
            version: 0,
            owner: id,
            status: 'pending',
            content_revision: revision,
            token: randomUUID(),
            baseline: expected ?? (owned ? previous.baseline : undefined),
            playlist_id: owned ? previous.playlist_id : undefined,
          });
        })
        .immediate(),
    );
  }

  finishPreview(
    claim: PreviewState,
    outcome: Pick<PreviewState, 'status' | 'result' | 'baseline' | 'playlist_id'>,
  ): PreviewState {
    return this.access(true, (db) =>
      db
        .transaction(() => {
          const latest = this.readPreview(db);

          if (!latest || latest.generation !== claim.generation || latest.token !== claim.token)
            throw new BridgeError(
              'preview_conflict',
              'Preview ownership changed before receipt persistence.',
            );

          const draft = this.read(db, claim.owner!);
          const status =
            outcome.status === 'current' &&
            JSON.stringify(draft.entries.map((entry) => entry.track_id)) !==
              JSON.stringify(outcome.baseline)
              ? 'out_of_date'
              : outcome.status;

          return this.writePreview(db, { ...latest, ...outcome, status });
        })
        .immediate(),
    );
  }

  detachPreview(id: string, revision: number): void {
    this.access(true, (db) =>
      db
        .transaction(() => {
          if (this.read(db, id).revision !== revision)
            throw new BridgeError('draft_revision_conflict', 'Stale detach request.');

          if (this.readPreview(db)?.owner !== id)
            throw new BridgeError('preview_conflict', 'This draft does not own the preview.');

          this.writePreview(db, { generation: randomUUID(), version: 0, status: 'inactive' });
        })
        .immediate(),
    );
  }

  adoptPreview(
    id: string,
    revision: number,
    generation: string,
    playlistId: string,
    trackIds: string[],
  ): Draft {
    return this.access(true, (db) =>
      db
        .transaction(() => {
          const previous = this.read(db, id);
          const slot = this.readPreview(db);

          if (previous.revision !== revision)
            throw new BridgeError(
              'draft_revision_conflict',
              'Draft changed while reading the preview.',
            );

          if (slot?.owner !== id || slot.generation !== generation)
            throw new BridgeError('preview_conflict', 'Preview ownership changed.');

          if (previous.save?.status === 'pending')
            throw new BridgeError('operation_busy', 'Permanent save is pending.');

          // Match repeated occurrences from left to right, preserving existing identities.
          const remaining = [...previous.entries];
          const entries = trackIds.map((track_id) => {
            const index = remaining.findIndex((entry) => entry.track_id === track_id);

            return index < 0 ? { entry_id: randomUUID(), track_id } : remaining.splice(index, 1)[0];
          });
          const ids = new Set(entries.map((entry) => entry.entry_id));
          const changed =
            JSON.stringify(previous.entries.map((entry) => entry.track_id)) !==
            JSON.stringify(trackIds);
          const draft = Draft.parse({
            ...previous,
            entries,
            revision: revision + 1,
            selected_entry_ids: previous.selected_entry_ids.filter((entry) => ids.has(entry)),
            ...(changed ? { save: undefined } : {}),
          });

          db.prepare('UPDATE drafts SET body = ? WHERE id = ?').run(JSON.stringify(draft), id);
          this.writePreview(db, {
            ...slot,
            status: 'current',
            content_revision: draft.revision,
            token: randomUUID(),
            baseline: trackIds,
            playlist_id: playlistId,
            result: { adopted_live: true, playlist_id: playlistId, observed_track_ids: trackIds },
          });

          return draft;
        })
        .immediate(),
    );
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

          const slot = this.readPreview(db);

          if (
            slot?.owner === id &&
            slot.status === 'pending' &&
            JSON.stringify(previous.entries.map((entry) => entry.track_id)) !==
              JSON.stringify(next.entries.map((entry) => entry.track_id))
          )
            throw new BridgeError(
              'operation_busy',
              'Preview write pending.',
              'The ordered edit was not applied. Wait for the active preview attempt, then get the latest draft and reconcile; interrupted attempts require explicit preview recovery.',
            );

          if (
            next.save?.status === 'pending' &&
            previous.save?.status !== 'pending' &&
            slot?.owner === id &&
            slot.status !== 'current'
          )
            throw new BridgeError(
              'preview_conflict',
              'Resolve the linked preview before permanent save.',
              'The auditioned preview and local draft have an unresolved difference. Reconcile and explicitly synchronize the preview before approving Save.',
            );

          db.prepare('UPDATE drafts SET body = ? WHERE id = ?').run(JSON.stringify(next), id);

          if (
            slot?.owner === id &&
            ['current', 'out_of_date'].includes(slot.status) &&
            JSON.stringify(previous.entries.map((entry) => entry.track_id)) !==
              JSON.stringify(next.entries.map((entry) => entry.track_id))
          ) {
            this.writePreview(db, { ...slot, status: 'out_of_date' });
          }

          return next;
        })
        .immediate(),
    );
  }
}
