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
untouched. Reconciliation reports the collision instead of resolving it, because
the two notes need not describe the same playlist. The refused note outlives the
refresh that rekeyed the receipt — this refresh's prune ran before the rekey,
while the receipt still shielded the stale ID — and the next prune collects it.

Read-only diagnostics bypass the writable facade and query factories. Their
separate query-only connection must not initialize or migrate the cache. See
[cache migrations](cache-migrations.md) for persisted-state and backup requirements.
