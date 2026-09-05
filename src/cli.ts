// Selecta CLI command construction. Two hard constraints: the bare invocation
// starts the MCP server, and stdout contains only protocol traffic or one JSON
// result from an explicit CLI verb.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Command, InvalidArgumentError } from 'commander';
import { refreshLibrary } from './operations/refresh.js';
import { bridge as defaultBridge } from './bridge/index.js';
import { SelectaCache, defaultDbPath } from './cache/index.js';
import { runDoctor } from './diagnostics/doctor.js';
import { readStatus } from './diagnostics/status.js';
import { enrichPendingTracks } from './enrich/index.js';
import { log as defaultLogger, type Logger } from './log.js';
import { createServer } from './server.js';
import type { Bridge } from './types/bridge.js';
import { BridgeError, defaultHints } from './types/errors.js';

export type CliOptions = {
  bridge?: Bridge;
  dbPath?: string;
  logger?: Logger;
  musicCheck?: () => Promise<void>;
  setExitCode?: (code: number) => void;
  writeStderr?: (text: string) => void;
  writeStdout?: (text: string) => void;
};

function lazyCache(dbPath: string): () => SelectaCache {
  let cache: SelectaCache | undefined;
  return () => (cache ??= SelectaCache.open(dbPath));
}

function formatEta(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function createCliProgram(options: CliOptions = {}): Command {
  const bridge = options.bridge ?? defaultBridge;
  const dbPath = options.dbPath ?? defaultDbPath();
  const logger = options.logger ?? defaultLogger;
  const setExitCode = options.setExitCode ?? ((code) => (process.exitCode = code));
  const writeStderr = options.writeStderr ?? ((text) => process.stderr.write(text));
  const writeStdout = options.writeStdout ?? ((text) => process.stdout.write(text));
  const writeJson = (value: unknown): void => writeStdout(JSON.stringify(value, null, 2) + '\n');

  function reportError(err: unknown): void {
    if (err instanceof BridgeError) {
      logger.error(`[${err.errorCode}] ${err.message}`);
      logger.error(`hint: ${err.hint ?? defaultHints[err.errorCode]}`);
    } else {
      logger.error('Unexpected error:', err instanceof Error ? err.message : String(err));
    }
  }

  const program = new Command();
  program
    .name('selecta')
    .description('Local MCP server exposing the Apple Music library to Claude')
    .configureOutput({ writeOut: writeStderr, writeErr: writeStderr });

  program
    .command('serve', { isDefault: true })
    .description('Start the MCP server over stdio (default when no verb is given)')
    .action(async () => {
      const server = createServer({ cache: lazyCache(dbPath), bridge });
      await server.connect(new StdioServerTransport());
      logger.info('selecta MCP server listening on stdio');
    });

  program
    .command('status')
    .description('Report read-only cache and enrichment diagnostics as JSON')
    .action(() => {
      const result = readStatus(dbPath);
      writeJson(result);
      if (!result.ok) {
        logger.error(`[cache_unavailable] ${result.database.errors.join('; ')}`);
        setExitCode(1);
      }
    });

  program
    .command('doctor')
    .description('Run status plus a read-only Music.app and Automation check')
    .action(async () => {
      const result = await runDoctor(dbPath, options.musicCheck);
      writeJson(result);
      if (!result.ok) {
        if (result.database.errors.length) {
          logger.error(`[cache_unavailable] ${result.database.errors.join('; ')}`);
        }
        if (result.music_app.message) {
          logger.error(`[${result.music_app.status}] ${result.music_app.message}`);
          if (result.music_app.hint) logger.error(`hint: ${result.music_app.hint}`);
        }
        setExitCode(1);
      }
    });

  program
    .command('refresh')
    .description('Full library reread from Music.app into the local SQLite cache')
    .action(async () => {
      try {
        const cache = SelectaCache.open(dbPath);
        try {
          writeJson({ ...(await refreshLibrary(cache, bridge)), db_path: dbPath });
        } finally {
          cache.close();
        }
      } catch (err) {
        reportError(err);
        setExitCode(1);
      }
    });

  program
    .command('enrich')
    .description(
      'Fetch audio features (bpm/key/danceability) from MusicBrainz/AcousticBrainz/Deezer for tracks not yet attempted',
    )
    .option(
      '-n, --limit <count>',
      'stop after this many tracks (default: all pending)',
      (value) => {
        const count = Number(value);
        if (!Number.isInteger(count) || count < 1) {
          throw new InvalidArgumentError('must be a positive integer');
        }
        return count;
      },
    )
    .action(async ({ limit }: { limit?: number }) => {
      try {
        const cache = SelectaCache.open(dbPath);
        const pending = cache.countPendingEnrichment();
        const budget = Math.min(limit ?? pending, pending);
        logger.info(
          `${pending} tracks pending enrichment; attempting ${budget} at ~1-2s each (source rate limits)`,
        );
        const startedAt = Date.now();
        const summary = await enrichPendingTracks(
          cache,
          { limit: budget },
          {
            onProgress: (progress) => {
              const covered = progress.processed + progress.skipped;
              const pct = Math.floor((covered / budget) * 100);
              const remaining = budget - covered;
              const eta =
                remaining === 0
                  ? 'done'
                  : `~${formatEta(remaining * ((Date.now() - startedAt) / covered))} remaining`;
              const skipped = progress.skipped > 0 ? `, ${progress.skipped} skipped` : '';
              logger.info(
                `enriched ${progress.enriched}/${progress.processed} attempted — ${pct}% of ${budget}${skipped}, ${eta}`,
              );
            },
            onChunkError: (message, trackCount) =>
              logger.error(`chunk skipped (${trackCount} tracks stay pending): ${message}`),
            trace: (line) => logger.info(line),
          },
        );
        cache.close();
        writeJson({
          processed: summary.processed,
          enriched: summary.enriched,
          no_data: summary.noData,
          no_match: summary.noMatch,
          skipped: summary.skipped,
          source_errors: summary.errors,
          pending_remaining: summary.pendingRemaining,
          db_path: dbPath,
        });
      } catch (err) {
        reportError(err);
        setExitCode(1);
      }
    });

  return program;
}

export async function runCli(args = process.argv, options: CliOptions = {}): Promise<void> {
  await createCliProgram(options).parseAsync(args);
}
