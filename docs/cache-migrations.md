# Cache schema migrations

Writable cache opens run `src/cache/migrations.ts` before preparing queries.
`PRAGMA user_version` records the installed version. Fresh memory and disk
caches and upgrades all use this path. `status` and `doctor` open their own
read-only connections and never migrate a database.

Version 0 means an unversioned database (including an empty one). All released
unversioned schemas evolved by adding tables and indexes. Version 1 applies
the frozen `src/cache/schema.ts` with `IF NOT EXISTS`: existing tables, rowids,
FTS contents, track and playlist IDs, features, history, notes, refresh logs,
creation receipts, and enrichment cooldowns are retained. Missing objects are
created. No refresh or persistent-ID remapping occurs.

The runner first reads the installed version without a writer lock and returns
if it is already current. Otherwise it takes an immediate transaction and re-reads
the version, then executes pending steps in ascending order, updating the version
after each step. The entire pending upgrade commits together. An error rolls back schema,
data, and version changes; the opening connection closes and reports
`cache_unavailable` with the underlying error. The original database remains
available for the previous build or an explicit later attempt. A database newer
than the running build is rejected, never downgraded or reset.

## Adding a migration

1. Append a consecutive version and SQL to `MIGRATIONS`. Never edit a shipped
   migration or the version-1 baseline. Keep SQL transactional: no transaction
   control, `VACUUM`, journal-mode changes, external I/O, or direct version writes.
2. Add immutable old-schema fixtures and representative data. Test fresh memory
   and disk creation, upgrades, preservation, reopen/once-only behavior, and an
   injected late failure that proves all pending steps roll back. Use temporary
   databases, never the real library. Test through `npm test`, not bare Vitest.
3. Run `npm run check`. Review whether queries and read-only diagnostics need
   adjustments for the new schema; diagnostics must never invoke the migrator.

## Backup policy for destructive migrations

Version 1 is additive and needs no backup. Before shipping the first migration
that rewrites or removes existing data, implement and test a backup gate:

- Stop other Selecta writers for the backup and upgrade. Create a unique sibling
  backup tagged with the source version, before any migration writes. Use SQLite's
  backup API (including committed WAL content), never copy only the database file.
- Verify the backup opens and passes `PRAGMA integrity_check`. If backup creation
  or verification fails (including disk full or permissions), fail the open with
  `cache_unavailable` and leave the original untouched. Never overwrite an older
  backup or silently delete backups after a successful upgrade.
- Surface the backup path and restoration instructions. Restore explicitly with
  all Selecta connections stopped: preserve the failed database and its WAL/SHM
  files together, then restore the verified backup to the original path with no
  stale WAL/SHM beside it. Reopen using a build supporting its source version.
- Test a committed WAL snapshot, failed backup, failed migration, and restoration
  of all retained data. Transaction rollback remains required even with a backup.

This gate is a prerequisite for destructive SQL; the current synchronous runner
has no backup implementation and must not acquire destructive steps until the
gate exists. Backup retention and restoration are explicit user actions.
