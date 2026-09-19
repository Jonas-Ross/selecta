// Subprocess adapter for metrognome (https://github.com/Jonas-Ross/metrognome),
// which estimates tempo and key from a track's 30-second store preview. One
// long-lived `batch` process per run: queries go down its stdin as JSON lines
// and results come back on stdout as they finish, so a library-sized backlog
// streams instead of buffering.
//
// metrognome knows nothing about Selecta. The only Selecta-shaped thing that
// crosses the pipe is client_ref, an opaque echo field carrying the Music.app
// persistent ID so a result finds its row without relying on ordering.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { BridgeError } from '../types/errors.js';
import type { AudioFeaturesRow, FeatureStatus } from '../types/cache.js';
import { blankFeatures } from '../cache/audio_features.js';
import { mgAnalysis, type MgAnalysis } from './schemas.js';
import { parsePayload } from '../types/validation.js';

export const METROGNOME_PATH_ENV = 'SELECTA_METROGNOME_PATH';
const DEFAULT_BINARY = 'metrognome';

// The one schema_version this build understands. metrognome bumps it when a
// field moves or changes meaning, so a mismatch is refused rather than read
// optimistically — a misread feature is worse than a missing one.
export const SUPPORTED_SCHEMA_VERSION = 2;

// Tracks in flight inside metrognome. Store resolution is rate limited there
// regardless; this only overlaps the preview downloads.
const DEFAULT_CONCURRENCY = 4;

/**
 * Which failures are the track's rather than the environment's.
 *
 * A title the store cannot identify, or a preview that yields nothing
 * decodable, will read the same on every future run, so it is recorded
 * terminally. Transport, cache and internal failures say nothing about the
 * track and leave it pending.
 */
const TERMINAL_ERRORS: Record<string, FeatureStatus> = {
  no_match: 'no_match',
  not_found: 'no_match',
  no_preview: 'no_data',
  decode: 'no_data',
  unusable_audio: 'no_data',
};

export type AnalysisQuery = { clientRef: string; artist: string; title: string };

/** The slice of a child process this adapter drives; tests supply a stand-in. */
export type ChildLike = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
};

export type SpawnLike = (command: string, args: string[]) => ChildLike;

export type MetrognomeDeps = {
  binaryPath?: string;
  concurrency?: number;
  spawnLike?: SpawnLike;
  trace?: (line: string) => void;
};

/** Configured path, then the environment, then whatever is on PATH. */
export function metrognomePath(deps: MetrognomeDeps = {}): string {
  return deps.binaryPath ?? process.env[METROGNOME_PATH_ENV] ?? DEFAULT_BINARY;
}

/**
 * Run one batch through metrognome, calling back per result as it streams.
 *
 * Throws BridgeError('enrichment_error') when the binary is missing or the
 * run dies part-way; results already handed to `onResult` stand, so a caller
 * keeps what landed before the failure. A non-zero exit on its own is normal
 * — metrognome exits 1 when any row failed, and those rows are results.
 */
export async function analyzeTracks(
  queries: readonly AnalysisQuery[],
  onResult: (analysis: MgAnalysis) => void,
  deps: MetrognomeDeps = {},
): Promise<void> {
  if (queries.length === 0) return;

  const command = metrognomePath(deps);
  const trace = deps.trace ?? (() => {});
  const args = ['batch', '--concurrency', String(deps.concurrency ?? DEFAULT_CONCURRENCY)];

  let child: ChildLike;

  try {
    child = (deps.spawnLike ?? defaultSpawn)(command, args);
  } catch (err) {
    throw unreachable(command, err);
  }

  let received = 0;
  let failure: Error | null = null;

  // Both signals are needed: the process can close while readline is still
  // draining buffered stdout, and a short result count then reads as a truncated
  // run rather than the complete one it is.
  const finished = new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    let drained = false;
    let exit: { code: number | null; signal: string | null } | null = null;

    const settle = (): void => {
      if (!drained || exit == null) return;

      if (failure != null) return reject(failure);

      if (received < queries.length) {
        return reject(
          new BridgeError(
            'enrichment_error',
            `metrognome ended after ${received}/${queries.length} results (${exit.signal != null ? `signal ${exit.signal}` : `exit ${exit.code}`})`,
          ),
        );
      }

      resolve();
    };

    lines.on('line', (line) => {
      if (line.trim() === '') return;

      try {
        onResult(parseLine(line));
        received += 1;
      } catch (err) {
        failure ??= err as Error;
      }
    });

    lines.on('close', () => {
      drained = true;
      settle();
    });

    child.on('error', (err) => reject(unreachable(command, err)));
    child.on('close', (code, signal) => {
      exit = { code, signal };
      settle();
    });
  });

  const logs = createInterface({ input: child.stderr });

  logs.on('line', (line) => trace(`metrognome: ${line}`));

  // stdin breaks when the process dies; `close` carries the real reason.
  child.stdin.on('error', () => {});
  // Racing the run: a process that died mid-write will never drain, so waiting
  // on the write alone would hang instead of reporting the failure.
  await Promise.race([writeQueries(child.stdin, queries), finished.catch(() => {})]);
  await finished;
}

function defaultSpawn(command: string, args: string[]): ChildLike {
  return spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

// The message carries the fix, not the hint: a failed run surfaces in the
// summary's source_errors, which is the message alone.
function unreachable(command: string, err: unknown): BridgeError {
  const detail = err instanceof Error ? err.message : String(err);

  return new BridgeError(
    'enrichment_error',
    `metrognome could not be run at "${command}": ${detail}. Install it (https://github.com/Jonas-Ross/metrognome) or point ${METROGNOME_PATH_ENV} at the binary.`,
  );
}

function parseLine(line: string): MgAnalysis {
  let body: unknown;

  try {
    body = JSON.parse(line);
  } catch {
    throw new BridgeError('enrichment_error', 'metrognome wrote a non-JSON line on stdout');
  }

  const analysis = parsePayload(mgAnalysis, body, 'metrognome', 'enrichment_error');

  if (analysis.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    throw new BridgeError(
      'enrichment_error',
      `metrognome speaks schema_version ${analysis.schema_version}; this build reads ${SUPPORTED_SCHEMA_VERSION}`,
      'Upgrade whichever of Selecta and metrognome is older.',
    );
  }

  return analysis;
}

// Respect backpressure: a full-library run is thousands of lines, and an
// unheeded `write` returning false buffers all of them in this process.
async function writeQueries(stdin: Writable, queries: readonly AnalysisQuery[]): Promise<void> {
  for (const query of queries) {
    const line = `${JSON.stringify({ artist: query.artist, title: query.title, client_ref: query.clientRef })}\n`;

    if (!stdin.write(line)) {
      await new Promise<void>((resolve) => stdin.once('drain', resolve));
    }
  }

  stdin.end();
}

/**
 * A streamed result as a storable features row, or null when the failure was
 * the environment's and the track should stay pending.
 *
 * A feature metrognome flagged uncertain is dropped rather than stored: the
 * flag means "hint", and a hint sitting in a column read as a measurement is
 * exactly the wrong data this pipeline exists to avoid.
 */
export function toFeaturesRow(analysis: MgAnalysis, fetchedAt: string): AudioFeaturesRow | null {
  const trackPersistentId = analysis.query.client_ref;

  if (trackPersistentId == null) return null;

  const row = blankFeatures(trackPersistentId, fetchedAt);

  if (analysis.status === 'error') {
    const status = TERMINAL_ERRORS[analysis.error?.kind ?? ''];

    if (status == null) return null;

    return { ...row, status, analysisStatus: status };
  }

  const sources: NonNullable<AudioFeaturesRow['sources']> = {};
  const tempo = analysis.features.tempo;
  const key = analysis.features.key;

  if (tempo != null && !tempo.uncertain) {
    row.bpm = tempo.bpm;
    row.bpmConfidence = tempo.confidence;
    row.bpmMaturity = tempo.maturity;
    sources.bpm = tempo.source;
  }

  if (key != null && !key.uncertain) {
    row.musicalKey = key.key;
    row.camelot = key.camelot ?? null;
    row.keyConfidence = key.confidence;
    row.keyMaturity = key.maturity;
    sources.musicalKey = key.source;
  }

  // Reached the audio and stood behind nothing: terminal, not worth the CPU twice.
  const status: FeatureStatus = Object.keys(sources).length > 0 ? 'ok' : 'no_data';

  row.sources = status === 'ok' ? sources : null;
  row.status = status;
  row.analysisStatus = status;

  return row;
}
