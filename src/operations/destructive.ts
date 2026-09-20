// The shared shape for any CLI command that destroys or overwrites cache rows.
// Two properties hold for all of them: nothing is written without --apply, and
// what is written is recoverable from a journal. docs/destructive-commands.md
// records why, and what is deliberately outside this convention.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  apply: () => S;
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

export function writeUndoJournal(
  dbPath: string,
  command: string,
  args: Record<string, unknown>,
  rows: JournalRows,
): string {
  const now = new Date();
  const path = journalPathFor(dbPath, command, now);
  const journal: UndoJournal = {
    journal_version: JOURNAL_VERSION,
    command,
    arguments: args,
    written_at: now.toISOString(),
    db_path: resolve(dbPath),
    rows,
  };

  mkdirSync(journalDir(dbPath), { recursive: true });
  writeFileSync(path, JSON.stringify(journal, null, 2) + '\n', 'utf8');

  return path;
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

  const journal = writeUndoJournal(context.dbPath, change.command, change.arguments, change.before);

  return { ...base, dry_run: false, summary: change.apply(), undo_journal: journal };
}
