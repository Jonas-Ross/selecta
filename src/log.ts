// stdout is reserved for the MCP protocol channel (and, for CLI verbs, the
// single JSON result), so all terminal logging goes to stderr. When explicitly
// enabled, the same lines are also appended to the local debug log.

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Logger = {
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

type LoggerOptions = {
  debugEnabled?: () => boolean;
  logPath?: string;
  now?: () => Date;
  writeStderr?: (line: string) => void;
};

export function defaultLogPath(): string {
  return join(homedir(), 'Library', 'Logs', 'Selecta', 'selecta.log');
}

function format(args: unknown[]): string {
  return args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const debugEnabled = options.debugEnabled ?? (() => process.env.SELECTA_DEBUG === '1');
  const logPath = options.logPath ?? defaultLogPath();
  const now = options.now ?? (() => new Date());
  const writeStderr = options.writeStderr ?? ((line) => process.stderr.write(line));
  let fileFailureReported = false;

  function append(level: 'info' | 'debug' | 'error', message: string): void {
    if (!debugEnabled()) return;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${now().toISOString()} ${level.toUpperCase()} ${message}\n`, 'utf8');
    } catch (err) {
      if (fileFailureReported) return;
      fileFailureReported = true;
      const detail = err instanceof Error ? err.message : String(err);
      writeStderr(`[debug-log] Could not append to ${logPath}: ${detail}\n`);
    }
  }

  function write(level: 'info' | 'debug' | 'error', args: unknown[]): void {
    const message = format(args);
    writeStderr(message + '\n');
    append(level, message);
  }

  return {
    info: (...args) => write('info', args),
    debug: (...args) => {
      if (debugEnabled()) write('debug', args);
    },
    error: (...args) => write('error', args),
  };
}

export const log = createLogger();
