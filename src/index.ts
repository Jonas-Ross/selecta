#!/usr/bin/env node
// Selecta CLI entrypoint — a commander verb dispatcher. Two hard constraints
// (CLAUDE.md): the bare, no-arg invocation must START THE MCP SERVER (Claude
// Desktop/Code spawn the bin with stdio as the protocol channel — printing help
// would corrupt the wire), and all commander output routes to stderr so stdout
// stays pure MCP.

import { Command } from 'commander';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { bridge } from './bridge/index.js';
import { SelectaCache, defaultDbPath } from './cache/index.js';
import { enrichPendingTracks } from './enrich/index.js';
import { createServer } from './server.js';
import { BridgeError, defaultHints } from './types/errors.js';
import { log } from './log.js';

// The cache opens lazily on first tool call: cold start stays fast and a
// broken cache surfaces as a per-call cache_unavailable envelope, not a crash
// that takes the whole MCP server down with it.
function lazyCache(): () => SelectaCache {
  let cache: SelectaCache | undefined;
  return () => (cache ??= SelectaCache.open());
}

function reportError(err: unknown): void {
  if (err instanceof BridgeError) {
    log.error(`[${err.errorCode}] ${err.message}`);
    log.error(`hint: ${err.hint ?? defaultHints[err.errorCode]}`);
  } else {
    log.error('Unexpected error:', err instanceof Error ? err.message : String(err));
  }
}

const program = new Command();

program
  .name('selecta')
  .description('Local MCP server exposing the Apple Music library to Claude')
  .configureOutput({
    writeOut: (s) => process.stderr.write(s),
    writeErr: (s) => process.stderr.write(s),
  });

program
  .command('serve', { isDefault: true })
  .description('Start the MCP server over stdio (default when no verb is given)')
  .action(async () => {
    const server = createServer({ cache: lazyCache(), bridge });
    await server.connect(new StdioServerTransport());
    log.info('selecta MCP server listening on stdio');
  });

program
  .command('refresh')
  .description('Full library reread from Music.app into the local SQLite cache')
  .action(async () => {
    try {
      const started = Date.now();
      log.info('Reading library from Music.app (this can take a while)…');
      const snapshot = await bridge.readLibrary();
      const durationMs = Date.now() - started;
      const cache = SelectaCache.open();
      const result = cache.refreshFromSnapshot(snapshot, { durationMs });
      cache.close();
      // CLI verbs print their final result to stdout — they are not the MCP server.
      process.stdout.write(
        JSON.stringify(
          {
            duration_ms: durationMs,
            track_count: result.trackCount,
            playlist_count: result.playlistCount,
            refreshed_at: result.refreshedAt,
            db_path: defaultDbPath(),
          },
          null,
          2,
        ) + '\n',
      );
    } catch (err) {
      reportError(err);
      process.exitCode = 1;
    }
  });

program
  .command('enrich')
  .description(
    'Fetch audio features (bpm/key/danceability) from MusicBrainz/AcousticBrainz/Deezer for tracks not yet attempted',
  )
  .option('-n, --limit <count>', 'stop after this many tracks (default: all pending)', (v) =>
    parseInt(v, 10),
  )
  .action(async ({ limit }: { limit?: number }) => {
    try {
      const cache = SelectaCache.open();
      const pending = cache.countPendingEnrichment();
      const budget = Math.min(limit ?? pending, pending);
      log.info(
        `${pending} tracks pending enrichment; attempting ${budget} at ~1-2s each (source rate limits)`,
      );
      // One engine call — it saves per 25-track chunk, so Ctrl-C loses at
      // most the chunk in flight; the callback narrates each chunk landing.
      const summary = await enrichPendingTracks(cache, { limit: budget }, {
        onProgress: (p) =>
          log.info(`enriched ${p.enriched}/${p.processed} attempted, ${budget - p.processed} to go`),
      });
      cache.close();
      process.stdout.write(
        JSON.stringify(
          {
            processed: summary.processed,
            enriched: summary.enriched,
            no_data: summary.noData,
            no_match: summary.noMatch,
            pending_remaining: summary.pendingRemaining,
            db_path: defaultDbPath(),
          },
          null,
          2,
        ) + '\n',
      );
    } catch (err) {
      reportError(err);
      process.exitCode = 1;
    }
  });

await program.parseAsync();
