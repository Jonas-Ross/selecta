// Compose connection-owned queries. SelectaCache owns transaction boundaries;
// query modules neither open connections nor start transactions.
import type { Database } from 'better-sqlite3';
import { createDiscoveryQueries } from './queries/discovery.js';
import { createLibraryQueries } from './queries/library.js';
import { createPlaylistsQueries } from './queries/playlists.js';
import { createMetadataQueries } from './queries/metadata.js';

export type Queries = ReturnType<typeof createQueries>;

export function createQueries(db: Database) {
  const metadata = createMetadataQueries(db);

  return {
    ...createDiscoveryQueries(db),
    ...createLibraryQueries(db),
    ...createPlaylistsQueries(db, metadata),
    ...metadata,
  };
}
