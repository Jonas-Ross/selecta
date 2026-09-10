# Cache organization

`SelectaCache` in `src/cache/index.ts` is the public API for tools and plain Node
consumers. It opens the connection, coordinates query calls, and owns transaction
boundaries. `queries.ts` composes the internal query factories once per cache
instance, preserving the named query methods behind that facade.

| Module under `src/cache/` | Responsibility |
| --- | --- |
| `queries/discovery.ts` | Track and playlist reads, search, overview, co-occurrence, and deterministic deduplication |
| `queries/shared.ts` | Track/playlist projections, effective BPM, FTS escaping, and shared track-filter predicates |
| `queries/library.ts` | Track persistence, refresh pruning, play-history counters/windows, refresh log, freshness, and FTS rebuild |
| `queries/playlists.ts` | Playlist rows/membership writes, deletion, creation receipts, and receipt aliases |
| `queries/metadata.ts` | Audio features, enrichment backlog/cooldowns, and note reads/writes/moves |
| `reconciliation.ts` | Pure receipt matching: rekeys and ambiguous groups |

Query factories prepare fixed SQL once per connection. Discovery constructs
filter-dependent SQL when called; bound parameters carry input values. All
discovery projections and faceted filters share the same SQL fragments, including
effective BPM and note columns. Notes remain projection-only and never affect
filters, sorting, or FTS. The composition passes the recent-activity cutoff helper
to discovery so every recent-activity surface uses the same window.

Query modules do not start transactions. Compound writes and the explorer's
compound read retain their transaction boundaries in the facade. Refresh reads
previous counters before upserting tracks, replaces playlist memberships, prunes
missing subjects and dependent rows, rebuilds FTS, then appends the refresh log
inside its transaction. Refresh-wide pruning stays together in `library.ts` even
when it removes features or notes; this makes deletion order and the receipt
window protecting missing playlist notes explicit.

Playlist deletion reuses the metadata module's prepared note-deletion operation.
The facade combines playlist deletion with receipt retirement, and combines note
moves with receipt rekeys. Those cross-module writes stay in the same transaction;
the query factories do not independently commit them.

Reconciliation data loading stays in the facade: it reads recent receipts,
same-name user playlist candidates and their ordered entries, plus whether the
current ID still exists. The pure planner receives those observations and the
reserved slot names. Ordinary rekeys require exact ordered entries, including
duplicates; reserved slots can match by name. A surviving current ID prevents a
rekey, and multiple same-name candidates are reported as ambiguous once per name.
Planning does not apply writes or open a transaction.

Schema initialization and migrations remain in `db.ts` and `migrations.ts`.
Read-only diagnostics keep their separate query-only connection and do not open
the writable facade or initialize its queries. See [cache migrations](cache-migrations.md)
for persisted-state and backup requirements.
