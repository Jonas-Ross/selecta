# Destructive commands

A CLI command that deletes or overwrites cache rows follows three rules. They
exist because of a single near miss: `supersede` took `--source` and
`--provenance`, the two could disagree, and a mismatch silently cleared values
the other source had written, with no way to get them back. A reviewer caught
it. Nothing in the code, the tests, or the command's own output would have.

None of the three is about that command. Each one removes a step from that
accident's path.

## 1. Nothing is written without `--apply`

A destructive command decides what it would change, prints it, and stops. The
same invocation with `--apply` carries it out. `--apply` is spelled the same
everywhere (`APPLY_FLAG_DESCRIPTION` in `src/operations/destructive.ts`).

The report says what is at stake, not just how much: `supersede`'s dry run
counts cleared fields per algorithm string, so "12 tracks" is also "12 tracks
whose key came from `metrognome/chroma-correlation-edm@1`". A count on its own
cannot answer *whose data am I about to lose*.

The apply consumes the decisions the dry run described (`planSupersedeFeatures`
produces them, `applySupersedeFeatures` replays them) rather than recomputing
from the flags. A dry run that computes one thing and an apply that computes
another is the same bug wearing a safety flag.

## 2. The summary accounts for every row that moved

`test/table_diff.ts` snapshots every user table, diffs two snapshots, and
`expectOnlyChanged` asserts the delta is exactly a stated list — empty for a
dry run. Every destructive command owes two tests using it:

- the dry run leaves the database byte-identical;
- the apply changes exactly the rows and columns its summary reports, across
  the whole cache and not only the table under test.

A test that asserts the intended change and says nothing about the rest stays
green while a command quietly touches something else. That is what happened.

## 3. An apply is recoverable from a journal

Before writing, a destructive command dumps every row it is about to overwrite
or remove to `<db-dir>/undo/<command>-<timestamp>.json`, and prints that path
as `undo_journal`. `node dist/index.js restore <journal>` puts those rows back
verbatim, bypassing the merge rule — a journalled value is the value that
belongs there, not a candidate to gap-fill with.

The journal is written before the transaction and narrowed to what the
transaction wrote once it commits. The two can differ: a refresh holds a
different lock, so it can prune a track between the plan and the write, and the
write skips that row rather than resurrect an orphan. Erring wide first means a
crash part-way through still leaves everything recoverable; narrowing after
means a restore never rewrites a row the run never touched — which, once that
track is re-added and re-enriched, would overwrite fresh values with stale ones.

A journal names the database it came from and is refused against any other, and
restore runs under the same `--apply` convention as the command it undoes, since
it too writes over live rows. A run that changes nothing writes no journal, and
neither does one whose write turns out to touch nothing, so the directory holds
only runs worth undoing. Journals are never pruned automatically; they are small, and deleting the user's only copy of a value to
save bytes would be the same class of mistake.

Restore skips a journalled row whose track has since left the library, and says
how many — re-adding it would orphan the row until the next refresh pruned it.

**The gap, stated plainly:** restore can put back a row that was removed, but
undoing a *restore* only covers rows it overwrote. A row restore re-added where
nothing existed is not removable by the counter-journal; supersede it again or
remove it by hand.

## What follows the convention today

- **`supersede`** clears values a named algorithm produced and reopens that
  source's attempt, so a better version of it can measure them again.
- **`reopen`** clears a source's terminal attempt for tracks that hold no value
  in a field. It writes no values at all, but it overwrites a status column, so
  it owes the same three rules. `docs/audio-features.md` explains why the two
  are separate commands: one names a provenance, and the tracks the other
  reaches have none.
- **`restore`** replays either one's journal, itself dry-run by default because
  it writes over live rows.

## What is deliberately outside this

- **`refresh` pruning.** Refresh deletes rows for tracks and playlists that
  left Music.app. That is reconciliation with the source of truth, not a
  destructive command: the deletions are derived, and the survive-refresh
  guarantee already keeps enrichment and notes for surviving tracks. A daily
  command that needed `--apply` would be a worse tool, and the prune is covered
  by `docs/cache-architecture.md`.
- **MCP tools.** `delete_playlist`, `remove_tracks` and `set_note` are already
  two-step: the model proposes, the user agrees, and the write goes through
  Music.app, which owns its own undo. A dry-run round trip inside the tool
  would add a turn to every edit and recover nothing extra.
- **Music.app writes generally.** A JSON journal cannot restore something
  Selecta does not own. The escape hatch covers cache rows only.
