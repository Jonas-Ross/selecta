// Terminal progress for long CLI runs. An enrichment backlog is minutes to
// hours of work, so silence reads as a hang. stdout stays the JSON channel:
// this owns stderr, and only redraws in place when stderr is a terminal, so a
// redirected run still produces a plain, greppable log.

import type { Logger } from './log.js';

export type ProgressSnapshot = {
  done: number;
  total: number;
  enriched: number; // values that landed in storage
  returned: number; // verdicts the source stood behind, landed or gap-filled away
  skipped: number;
  // The track the run most recently touched, or null before the first one.
  current: string | null;
};

export type ProgressReporter = {
  /** Counters moved, or the run started working on another track. */
  update: (snapshot: ProgressSnapshot) => void;
  /** A line worth keeping, printed above the live one. */
  note: (line: string, level: 'info' | 'debug' | 'error') => void;
  /** Take the live line down; the caller owns whatever is printed next. */
  stop: () => void;
};

export type ProgressOptions = {
  logger: Logger;
  writeStderr: (text: string) => void;
  isTty: boolean;
  columns?: () => number;
  now?: () => number;
  // A terminal repaints on a timer so elapsed time keeps moving through a slow
  // track; a redirected run logs at most one line per logEveryMs.
  repaintMs?: number;
  logEveryMs?: number;
};

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CLEAR_LINE = '\r\u001b[2K';

const isControl = (code: number): boolean => code < 0x20 || (code >= 0x7f && code <= 0x9f);

// Track titles are Music.app's text, not ours: a stray newline would add rows
// and an escape sequence could move the cursor or clear the line.
function safe(text: string): string {
  let out = '';

  for (const char of text) out += isControl(char.codePointAt(0)!) ? ' ' : char;

  return out;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));

  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) return `${minutes}m`;

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Tracks per second, or seconds per track once a track takes longer than one. */
function formatRate(done: number, elapsedMs: number): string | null {
  if (done === 0 || elapsedMs <= 0) return null;

  const perSecond = done / (elapsedMs / 1000);

  return perSecond >= 1 ? `${perSecond.toFixed(1)}/s` : `${(1 / perSecond).toFixed(1)}s each`;
}

// East Asian wide/fullwidth forms and emoji render two columns, so counting
// code units would let a CJK title wrap onto a second row. The symbol and
// emoji blocks are taken wholesale instead of code point by code point, since
// over-counting a narrow one only truncates a character early where
// under-counting a wide one wraps the line and leaves a stray row behind.
// Braille (U+2800-U+28FF, the spinner) is carved back out as genuinely narrow,
// and combining marks count as one rather than zero, erring the same safe way.
const WIDE =
  /[\u1100-\u115f\u2190-\u27ff\u2900-\u2bff\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\u{16fe0}-\u{1b152}\u{1f000}-\u{1faff}\u{20000}-\u{3fffd}]/u;

const charWidth = (char: string): number => (WIDE.test(char) ? 2 : 1);

/** Fit to a column budget, counting display width and never splitting a character. */
function truncate(line: string, columns: number): string {
  let width = 0;

  for (const char of line) width += charWidth(char);

  if (width <= columns) return line;

  let kept = '';

  width = 0;

  for (const char of line) {
    if (width + charWidth(char) > columns - 1) break;

    kept += char;
    width += charWidth(char);
  }

  return kept + '…';
}

/** Everything but the spinner, so the live line and a logged line say the same thing. */
function describe(snapshot: ProgressSnapshot, elapsedMs: number): string {
  const { done, total, enriched, returned, skipped, current } = snapshot;
  const parts = [`${done}/${total}`];

  if (total > 0) parts.push(`${Math.floor((done / total) * 100)}%`);

  parts.push(`${enriched} landed`);

  // Only when gap-fill has actually discarded something, so the usual line stays short.
  if (returned !== enriched) parts.push(`${returned} returned`);

  if (skipped > 0) parts.push(`${skipped} skipped`);

  const rate = formatRate(done, elapsedMs);

  if (rate != null) parts.push(rate);

  if (done > 0 && done < total && elapsedMs > 0) {
    parts.push(`${formatDuration((total - done) * (elapsedMs / done))} left`);
  }

  if (current != null) parts.push(safe(current));

  return parts.join(' · ');
}

export function createProgressReporter(options: ProgressOptions): ProgressReporter {
  const { logger, writeStderr, isTty } = options;
  const columns = options.columns ?? (() => process.stderr.columns || 80);
  const now = options.now ?? (() => Date.now());
  const repaintMs = options.repaintMs ?? 1000;
  const logEveryMs = options.logEveryMs ?? 15_000;
  const startedAt = now();

  let snapshot: ProgressSnapshot | null = null;
  let frame = 0;
  let painted = false;
  let loggedAt: number | null = null;
  let loggedDone = -1;
  let timer: ReturnType<typeof setInterval> | null = null;

  function paint(): void {
    if (snapshot == null) return;

    const spinner = SPINNER[frame % SPINNER.length];

    writeStderr(
      CLEAR_LINE + truncate(`${spinner} ${describe(snapshot, now() - startedAt)}`, columns()),
    );
    painted = true;
  }

  function clear(): void {
    if (!painted) return;

    writeStderr(CLEAR_LINE);
    painted = false;
  }

  /** One durable line per `logEveryMs`, so a redirected run logs without flooding. */
  function logThrottled(): void {
    if (snapshot == null) return;

    const at = now();
    const finished = snapshot.total > 0 && snapshot.done >= snapshot.total;
    const due =
      loggedAt == null || at - loggedAt >= logEveryMs || (finished && snapshot.done !== loggedDone);

    if (!due) return;

    loggedAt = at;
    loggedDone = snapshot.done;
    logger.info(describe(snapshot, at - startedAt));
  }

  if (isTty) {
    timer = setInterval(() => {
      frame += 1;
      paint();
    }, repaintMs);
    timer.unref?.();
  }

  return {
    update(next) {
      snapshot = next;

      if (isTty) paint();
      else logThrottled();
    },

    note(text, level) {
      clear();
      logger[level](safe(text));

      if (isTty) paint();
    },

    stop() {
      if (timer != null) clearInterval(timer);

      timer = null;
      clear();
    },
  };
}
