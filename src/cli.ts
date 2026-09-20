// Selecta CLI command construction. Two hard constraints: the bare invocation
// starts the MCP server, and stdout contains only protocol traffic or one JSON
// result from an explicit CLI verb.

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Command, InvalidArgumentError, Option } from 'commander';
import { refreshLibrary } from './operations/refresh.js';
import { releaseLocksOnShutdown } from './operations/shutdown.js';
import { withOperation } from './operations/lock.js';
import {
  APPLY_FLAG_DESCRIPTION,
  readUndoJournal,
  runDestructive,
  type DestructiveOutcome,
} from './operations/destructive.js';
import { planRestore } from './operations/restore.js';
import { bridge as defaultBridge } from './bridge/index.js';
import { SelectaCache, defaultDbPath } from './cache/index.js';
import { runDoctor } from './diagnostics/doctor.js';
import { readStatus, type SchemaVersions } from './diagnostics/status.js';
import { DraftStore, draftDbPath } from './drafts/store.js';
import { METROGNOME_PATH_ENV, enrichPendingTracks } from './enrich/index.js';
import type { FeatureSource } from './types/cache.js';
import { log as defaultLogger, type Logger } from './log.js';
import { createProgressReporter, formatDuration } from './progress.js';
import { createServer } from './server.js';
import type { Bridge } from './types/bridge.js';
import { BridgeError, defaultHints } from './types/errors.js';

export type CliOptions = {
  bridge?: Bridge;
  dbPath?: string;
  logger?: Logger;
  musicCheck?: () => Promise<void>;
  // Whether stderr can carry a redrawn progress line; a redirected run gets
  // plain lines instead.
  isTty?: boolean;
  setExitCode?: (code: number) => void;
  writeStderr?: (text: string) => void;
  writeStdout?: (text: string) => void;
};

function lazyCache(dbPath: string): () => SelectaCache {
  let cache: SelectaCache | undefined;

  return () => (cache ??= SelectaCache.open(dbPath));
}

export function createCliProgram(options: CliOptions = {}): Command {
  const bridge = options.bridge ?? defaultBridge;
  const dbPath = options.dbPath ?? defaultDbPath();
  const logger = options.logger ?? defaultLogger;
  const isTty = options.isTty ?? process.stderr.isTTY === true;
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

  // Diagnostics never migrate, so a stale count would otherwise read as the
  // current one.
  function reportPendingMigrations(schema: SchemaVersions | null): void {
    if (schema == null || schema.pending === 0) return;

    logger.error(
      `cache schema is version ${schema.version}, this build writes ${schema.expected}: ` +
        `${schema.pending} pending migration(s), so the counts above predate them.`,
    );
    logger.error(
      'hint: run `node dist/index.js refresh` to open the cache for write and apply them',
    );
  }

  // stdout carries the result; the nudge that nothing was written belongs on
  // stderr with the rest of the narration.
  function reportDryRun(outcome: DestructiveOutcome<unknown>): void {
    if (!outcome.dry_run) return;

    logger.info('dry run: nothing was written. Re-run with --apply to carry this out.');
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
      const server = createServer({
        cache: lazyCache(dbPath),
        bridge,
        drafts: () => new DraftStore(draftDbPath(dbPath)),
      });

      await server.connect(new StdioServerTransport());
      logger.info('selecta MCP server listening on stdio');
    });

  program
    .command('status')
    .description('Report read-only cache and enrichment diagnostics as JSON')
    .action(() => {
      const result = readStatus(dbPath);

      writeJson(result);
      reportPendingMigrations(result.database.schema);

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
      reportPendingMigrations(result.database.schema);

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
      'Fetch audio features for tracks not yet attempted: from MusicBrainz/AcousticBrainz/Deezer (--source catalog), or by analyzing store previews with metrognome (--source analysis)',
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
    .addOption(
      new Option('-s, --source <source>', 'where features come from')
        .choices(['catalog', 'analysis'])
        .default('catalog'),
    )
    .option(
      '--metrognome-path <path>',
      `path to the metrognome binary (--source analysis; default: $${METROGNOME_PATH_ENV} or metrognome on PATH)`,
    )
    .action(
      async ({
        limit,
        source,
        metrognomePath: binaryPath,
      }: {
        limit?: number;
        source: FeatureSource;
        metrognomePath?: string;
      }) => {
        // A full-library pass runs for hours, so Ctrl-C is a normal way to end
        // one; this process owns its signals, so it can drop the lock on the
        // way out and leave the backlog resumable.
        const stopShutdownHandler = releaseLocksOnShutdown();

        try {
          const cache = SelectaCache.open(dbPath);

          try {
            const pending = cache.countPendingEnrichment(source);
            const budget = Math.min(limit ?? pending, pending);

            logger.info(
              `${pending} tracks pending ${source} enrichment; attempting ${budget} at ~1-3s each`,
            );
            const startedAt = Date.now();
            const progress = createProgressReporter({ logger, writeStderr, isTty });
            // Per-request narration is debug-level: on a terminal it would
            // scroll the live line away, and it is what the file log is for.
            // Through the reporter even so, or SELECTA_DEBUG=1 would write it
            // onto the live line rather than above it.
            const trace = (line: string): void => progress.note(line, 'debug');
            const summary = await enrichPendingTracks(
              cache,
              { limit: budget, source },
              {
                metrognome: { binaryPath, trace },
                onProgress: ({ processed, enriched, returned, skipped }, current) =>
                  progress.update({
                    done: processed + skipped,
                    total: budget,
                    enriched,
                    returned,
                    skipped,
                    current,
                  }),
                onChunkError: (message, trackCount) =>
                  progress.note(
                    `chunk skipped (${trackCount} tracks stay pending): ${message}`,
                    'error',
                  ),
                trace,
              },
            ).finally(() => progress.stop());

            logger.info(
              `${summary.enriched} landed of ${summary.returned} returned, ${summary.processed} attempted in ${formatDuration(Date.now() - startedAt)}; ${summary.pendingRemaining} still pending ${source}`,
            );

            writeJson({
              source,
              processed: summary.processed,
              enriched: summary.enriched,
              returned: summary.returned,
              no_data: summary.noData,
              no_match: summary.noMatch,
              skipped: summary.skipped,
              source_errors: summary.errors,
              pending_remaining: summary.pendingRemaining,
              db_path: dbPath,
            });
          } finally {
            cache.close();
          }
        } catch (err) {
          reportError(err);
          setExitCode(1);
        } finally {
          stopShutdownHandler();
        }
      },
    );

  program
    .command('supersede')
    .description(
      'List what produced each stored audio feature; with --provenance, report what clearing those values would change, and with --apply carry it out so a later enrich re-measures them',
    )
    .addOption(
      new Option('-s, --source <source>', 'whose terminal attempt to reopen')
        .choices(['catalog', 'analysis'])
        .default('analysis'),
    )
    .option(
      '-p, --provenance <value...>',
      'algorithm strings to treat as superseded, exactly as listed (e.g. metrognome/chroma-correlation-edm@1)',
    )
    .option('--apply', APPLY_FLAG_DESCRIPTION)
    .action(
      async ({
        source,
        provenance,
        apply = false,
      }: {
        source: FeatureSource;
        provenance?: string[];
        apply?: boolean;
      }) => {
        try {
          const cache = SelectaCache.open(dbPath);

          try {
            // No provenance named is the survey: it reports what is stored and
            // changes nothing, which is also how a caller learns the exact
            // strings this command takes.
            if (provenance == null || provenance.length === 0) {
              writeJson({ provenance: cache.featureProvenance(), db_path: dbPath });

              return;
            }

            const { plan, outcome } = await withOperation(cache, 'enrich', async () => {
              const decided = cache.planSupersedeFeatures(source, provenance);

              return {
                plan: decided,
                outcome: runDestructive(
                  {
                    command: 'supersede',
                    arguments: { source, provenance },
                    summary: decided.summary,
                    empty: decided.changes.length === 0,
                    before: { audio_features: decided.changes.map((change) => change.before) },
                    apply: () => {
                      const { summary, applied } = cache.applySupersedeFeatures(decided);

                      return { summary, applied: { audio_features: applied } };
                    },
                  },
                  { apply, dbPath },
                ),
              };
            });

            // Same key and meaning as enrich's: the backlog this leaves behind.
            // A dry run adds the tracks it would reopen, which is not every row
            // it changes — one an earlier supersede reopened is pending already.
            const pendingRemaining =
              cache.countPendingEnrichment(source) + (outcome.dry_run ? plan.reopened : 0);

            writeJson({ ...outcome, pending_remaining: pendingRemaining });
            reportDryRun(outcome);
          } finally {
            cache.close();
          }
        } catch (err) {
          reportError(err);
          setExitCode(1);
        }
      },
    );

  program
    .command('restore')
    .argument('<journal>', 'path printed as undo_journal by the command to undo')
    .description('Put back the cache rows a destructive command journalled before it ran')
    .option('--apply', APPLY_FLAG_DESCRIPTION)
    .action(async (journalPath: string, { apply = false }: { apply?: boolean }) => {
      try {
        const cache = SelectaCache.open(dbPath);

        try {
          const journal = readUndoJournal(journalPath, dbPath);
          const outcome = await withOperation(cache, 'enrich', async () =>
            runDestructive(planRestore(cache, journal), { apply, dbPath }),
          );

          writeJson(outcome);
          reportDryRun(outcome);
        } finally {
          cache.close();
        }
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
