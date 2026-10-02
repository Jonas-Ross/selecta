// Finding the metrognome binary and refusing one too old to speak the JSON
// contract this build reads.

import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { BridgeError } from '../types/errors.js';

export const METROGNOME_PATH_ENV = 'SELECTA_METROGNOME_PATH';

// The first release that writes schema_version 2, the one parseLine accepts.
export const MIN_METROGNOME_VERSION = '0.1.0';

// MCP clients spawn Selecta with launchd's PATH, which has neither Homebrew prefix.
export const BREW_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

const INSTALL = `Install it with \`brew install jonas-ross/tap/metrognome\`, or point ${METROGNOME_PATH_ENV} at the binary.`;

const VERSION_TIMEOUT_MS = 10_000;

export type BinaryDeps = {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  isExecutable?: (path: string) => boolean;
  readVersion?: (command: string) => Promise<string>;
};

export type MetrognomeBinary = { path: string; version: string };

/** An explicit path or the environment wins; otherwise PATH, then Homebrew. */
export function findMetrognome(deps: BinaryDeps = {}): string | null {
  const env = deps.env ?? process.env;
  const override = deps.binaryPath ?? env[METROGNOME_PATH_ENV];

  if (override != null && override !== '') return override;

  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), ...BREW_BIN_DIRS];

  return dirs.map((dir) => join(dir, 'metrognome')).find(isExecutable) ?? null;
}

/**
 * The binary to run and its version, or BridgeError('enrichment_error') saying
 * how to fix it. The message carries the fix because a failed analysis run
 * surfaces in source_errors, which is the message alone.
 */
export async function resolveMetrognome(deps: BinaryDeps = {}): Promise<MetrognomeBinary> {
  const path = findMetrognome(deps);

  if (path == null) {
    throw new BridgeError(
      'enrichment_error',
      `metrognome was not found on PATH or in ${BREW_BIN_DIRS.join(' or ')}. ${INSTALL}`,
    );
  }

  let output: string;

  try {
    output = await (deps.readVersion ?? defaultReadVersion)(path);
  } catch (err) {
    throw unreachable(path, err);
  }

  const version = /^metrognome (\d+\.\d+\.\d+)/m.exec(output)?.[1];

  if (version == null) {
    throw new BridgeError(
      'enrichment_error',
      `"${path} --version" did not report a metrognome version (got ${JSON.stringify(output.trim().slice(0, 80))}). ${INSTALL}`,
    );
  }

  if (compareVersions(version, MIN_METROGNOME_VERSION) < 0) {
    throw new BridgeError(
      'enrichment_error',
      `metrognome ${version} at "${path}" is older than ${MIN_METROGNOME_VERSION}, the first release this build of Selecta can read. Upgrade it with \`brew upgrade metrognome\`.`,
    );
  }

  return { path, version };
}

export function unreachable(command: string, err: unknown): BridgeError {
  const detail = err instanceof Error ? err.message : String(err);

  return new BridgeError(
    'enrichment_error',
    `metrognome could not be run at "${command}": ${detail}. ${INSTALL}`,
  );
}

function compareVersions(a: string, b: string): number {
  const [left, right] = [a, b].map((v) => v.split('.').map(Number));

  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }

  return 0;
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);

    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultReadVersion(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, ['--version'], { timeout: VERSION_TIMEOUT_MS }, (err, stdout) =>
      err != null ? reject(err) : resolve(stdout),
    );
  });
}
