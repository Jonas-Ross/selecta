// Putting back what a destructive command took out. One table knows how to
// restore itself today; a future destructive command registers its table here
// rather than inventing a second undo path.

import type { SelectaCache } from '../cache/index.js';
import type { AudioFeaturesRow } from '../types/cache.js';
import { BridgeError } from '../types/errors.js';
import type { DestructiveChange, UndoJournal } from './destructive.js';

export type RestoreSummary = {
  tables: string[];
  rows: number;
  // A row whose track still has features is overwritten; one whose row was
  // removed comes back. The split matters: only the first can lose data.
  replacing: number;
  adding: number;
  // Rows whose track has since left the library, which restore skips rather
  // than orphan (the same rule enrichment writes follow).
  skipped: number;
};

function audioFeatureRows(rows: readonly unknown[], table: string): AudioFeaturesRow[] {
  return rows.map((row, index) => {
    if (
      row == null ||
      typeof row !== 'object' ||
      typeof (row as AudioFeaturesRow).trackPersistentId !== 'string'
    ) {
      throw new BridgeError(
        'validation_error',
        `Undo journal row ${index} of ${table} has no track_persistent_id`,
      );
    }

    return row as AudioFeaturesRow;
  });
}

/**
 * Decide what replaying a journal would put back, writing nothing.
 *
 * Restoring is itself a write over live rows, so it runs under the same
 * convention as the command it undoes: reported first, journalled on apply.
 */
export function planRestore(
  cache: SelectaCache,
  journal: UndoJournal,
): DestructiveChange<RestoreSummary> {
  const tables = Object.keys(journal.rows);
  const unknown = tables.filter((table) => table !== 'audio_features');

  if (unknown.length > 0) {
    throw new BridgeError(
      'validation_error',
      `Undo journal carries tables this build cannot restore: ${unknown.join(', ')}`,
    );
  }

  const journalled = audioFeatureRows(journal.rows.audio_features ?? [], 'audio_features');
  const rows = journalled.filter((row) => cache.getTrack(row.trackPersistentId) != null);
  const before = rows
    .map((row) => cache.getAudioFeatures(row.trackPersistentId))
    .filter((row): row is AudioFeaturesRow => row != null);

  const summary: RestoreSummary = {
    tables,
    rows: rows.length,
    replacing: before.length,
    adding: rows.length - before.length,
    skipped: journalled.length - rows.length,
  };

  return {
    command: 'restore',
    arguments: { undid: journal.command, written_at: journal.written_at },
    summary,
    empty: rows.length === 0,
    before: { audio_features: before },
    apply: () => {
      // A track pruned between deciding and writing is skipped by the cache, so
      // both the report and the journal are built from what landed rather than
      // from what was planned.
      const restored = new Set(cache.restoreAudioFeatures(rows));
      const replaced = before.filter((row) => restored.has(row.trackPersistentId));

      return {
        summary: {
          tables,
          rows: restored.size,
          replacing: replaced.length,
          adding: restored.size - replaced.length,
          skipped: journalled.length - restored.size,
        },
        applied: { audio_features: replaced },
      };
    },
  };
}
