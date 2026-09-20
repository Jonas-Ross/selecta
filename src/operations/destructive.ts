// The shared shape for any CLI command that destroys or overwrites cache rows.
// Two properties hold for all of them: nothing is written without --apply, and
// what is written is recoverable from a journal. docs/destructive-commands.md
// records why, and what is deliberately outside this convention.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BridgeError } from '../types/errors.js';

export const APPLY_FLAG_DESCRIPTION =
  'carry the change out; without it the command only reports what it would do';

const JOURNAL_VERSION = 1;

/** Rows exactly as stored now, per table, for a restore to put back verbatim. */
export type JournalRows = Record<string, readonly unknown[]>;

export type UndoJournal = {
  journal_version: number;
  command: string;
  arguments: Record<string, unknown>;
  written_at: string;
  db_path: string;
  rows: JournalRows;
};

/**
 * A destructive change, decided before anything is written.
 *
 * `apply` consumes the same decisions the summary describes, so a dry run and
 * the run it previews cannot drift — the bug class this guards against is a
 * command doing more than the caller was shown.
 */
export type DestructiveChange<S> = {
  command: string;
  arguments: Record<string, unknown>;
  summary: S;
  // True when the summary describes no change at all; an empty run writes no
  // journal, so the undo directory holds only runs worth undoing.
  empty: boolean;
  before: JournalRows;
  // Returns the rows it actually wrote over, which can be a subset of `before`
  // when a concurrent prune takes a row away between deciding and writing. The
  // journal is narrowed to these, so a restore never resurrects a row this run
  // never touched.
  apply: () => { summary: S; applied: JournalRows };
};

export type DestructiveOutcome<S> = {
  command: string;
  arguments: Record<string, unknown>;
  dry_run: boolean;
  summary: S;
  undo_journal: string | null;
  db_path: string;
};

function journalDir(dbPath: string): string {
  return join(dirname(resolve(dbPath)), 'undo');
}

/** Timestamped so a journal is never overwritten by the next run. */
function journalPathFor(dbPath: string, command: string, now: Date): string {
  const stamp = now.toISOString().replaceAll(':', '-').replace('.', '-');

  return join(journalDir(dbPath), `${command}-${stamp}.json`);
}

type JournalHandle = { path: string; journal: UndoJournal };

function writeJournalFile(path: string, journal: UndoJournal): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(journal, null, 2) + '\n', 'utf8');
}

function openUndoJournal(
  dbPath: string,
  command: string,
  args: Record<string, unknown>,
  rows: JournalRows,
): JournalHandle {
  const now = new Date();
  const handle: JournalHandle = {
    path: journalPathFor(dbPath, command, now),
    journal: {
      journal_version: JOURNAL_VERSION,
      command,
      arguments: args,
      written_at: now.toISOString(),
      db_path: resolve(dbPath),
      rows,
    },
  };

  writeJournalFile(handle.path, handle.journal);

  return handle;
}

/** Narrow a journal to what the transaction wrote, keeping its original path. */
function rewriteUndoJournal(handle: JournalHandle, rows: JournalRows): void {
  writeJournalFile(handle.path, { ...handle.journal, rows });
}

function journalIsEmpty(rows: JournalRows): boolean {
  return Object.values(rows).every((table) => table.length === 0);
}

/**
 * Read a journal back, refusing anything a restore cannot honour.
 *
 * The database path is part of that check: replaying one library's rows into
 * another would be the same accident this convention exists to prevent.
 */
export function readUndoJournal(path: string, dbPath: string): UndoJournal {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new BridgeError(
      'validation_error',
      `Could not read undo journal ${path}: ${err instanceof Error ? err.message : String(err)}`,
      'Pass the path printed as undo_journal by the command you want to undo.',
    );
  }

  const journal = parsed as Partial<UndoJournal>;

  if (journal.journal_version !== JOURNAL_VERSION) {
    throw new BridgeError(
      'validation_error',
      `Undo journal ${path} is version ${String(journal.journal_version)}, this build reads ${JOURNAL_VERSION}`,
    );
  }

  if (journal.rows == null || typeof journal.rows !== 'object') {
    throw new BridgeError('validation_error', `Undo journal ${path} carries no rows`);
  }

  for (const [table, rows] of Object.entries(journal.rows)) {
    if (!Array.isArray(rows)) {
      throw new BridgeError(
        'validation_error',
        `Undo journal ${path} holds something other than a list of rows for ${table}`,
      );
    }
  }

  if (journal.db_path !== resolve(dbPath)) {
    throw new BridgeError(
      'validation_error',
      `Undo journal ${path} was written for ${String(journal.db_path)}, not ${resolve(dbPath)}`,
      'Restore a journal into the database it came from.',
    );
  }

  return journal as UndoJournal;
}

/**
 * Report a destructive change, or carry it out behind a journal.
 *
 * Nothing is written when there is nothing to change, so an empty run leaves
 * no journal to sift through later.
 */
export function runDestructive<S>(
  change: DestructiveChange<S>,
  context: { apply: boolean; dbPath: string },
): DestructiveOutcome<S> {
  const base = {
    command: change.command,
    arguments: change.arguments,
    db_path: context.dbPath,
  };

  if (!context.apply || change.empty) {
    return { ...base, dry_run: !context.apply, summary: change.summary, undo_journal: null };
  }

  // Journalled before the write, so a crash part-way through still leaves every
  // row the run could have touched recoverable — a superset errs the safe way.
  // Once the transaction commits, the journal is narrowed to what it wrote.
  const handle = openUndoJournal(context.dbPath, change.command, change.arguments, change.before);
  const { summary, applied } = change.apply();

  if (journalIsEmpty(applied)) {
    rmSync(handle.path, { force: true });

    return { ...base, dry_run: false, summary, undo_journal: null };
  }

  rewriteUndoJournal(handle, applied);

  return { ...base, dry_run: false, summary, undo_journal: handle.path };
}
