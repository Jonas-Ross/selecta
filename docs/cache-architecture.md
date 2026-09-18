# Cache transaction boundaries

Query factories never start transactions. `SelectaCache` owns the transaction
that combines cross-module writes, such as playlist deletion with receipt
retirement or a note move with a receipt rekey. Query helpers must not commit
those operations independently.

Compound read responses resolve raw facts, playlist positions and freshness
within one deferred read transaction, including resource validation. A concurrent
WAL writer may commit a refresh while the response finishes its original snapshot.
End the transaction before wire projection or external I/O.

Refresh-wide pruning stays together in `queries/library.ts`, including dependent
features and notes. This keeps deletion order and the receipt window protecting
missing playlist notes under one owner. A note move is therefore never allowed to
delete a note: moving onto a playlist that already has one leaves the destination
untouched, and reconciliation reports the collision rather than resolving it.
The refused note outlives the refresh that rekeyed the receipt — that prune ran
before the rekey, with the stale ID still shielded — so the next one collects it.

The same collision marks the receipt itself (`playlist_creations.edit_conflict`,
migration version 2 — no backfill, since no prior rekey's collision is knowable
after the fact): a rekey can land on the user's own pre-existing same-name
playlist, and without a first-seen timestamp a note collision is the only
evidence available that the destination predates the receipt. Edit tools
(`resolveEditablePlaylist`, and `set_note`'s playlist branch) refuse a
conflicted receipt's ID rather than risk writing to that playlist. A later
write-time rekey (`applyLiveRekey`, resolved authoritatively from Music.app,
not by name/tracklist matching) supersedes the conflict and clears it.

Read-only diagnostics bypass the writable facade and query factories. Their
separate query-only connection must not initialize or migrate the cache. See
[cache migrations](cache-migrations.md) for persisted-state and backup requirements.
