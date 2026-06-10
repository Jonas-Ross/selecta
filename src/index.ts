#!/usr/bin/env node
// Selecta CLI entrypoint — a commander verb dispatcher. Two hard constraints
// (CLAUDE.md): the bare, no-arg invocation must START THE MCP SERVER (Claude
// Desktop/Code spawn the bin with stdio as the protocol channel — printing help
// would corrupt the wire), and all commander output routes to stderr so stdout
// stays pure MCP.

import { Command } from 'commander';
import { bridge } from './bridge/index.js';
import { SelectaCache, defaultDbPath } from './cache/index.js';
import { BridgeError, defaultHints } from './types/errors.js';
import { log } from './log.js';

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
    // M3 wires the real server here.
    log.error('The MCP server lands in M3 — for now only `selecta refresh` works.');
    process.exitCode = 1;
  });

program
  .command('refresh')
  .description('Full library reread from Music.app into the local SQLite cache')
  .action(async () => {
    try {
      const started = Date.now();
      log.info('Reading library from Music.app (this can take a while)…');
      const snapshot = await bridge.readLibrary();
      const cache = SelectaCache.open();
      const result = cache.refreshFromSnapshot(snapshot, {
        durationMs: Date.now() - started,
      });
      cache.close();
      // CLI verbs print their final result to stdout — they are not the MCP server.
      process.stdout.write(
        JSON.stringify(
          {
            duration_ms: Date.now() - started,
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

await program.parseAsync();
