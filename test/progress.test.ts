// The terminal progress line: live and redrawn in place on a TTY, plain
// throttled lines when stderr is redirected. stdout is never touched here.

import { describe, expect, it, vi } from 'vitest';
import { createProgressReporter, formatDuration } from '../src/progress.js';
import type { Logger } from '../src/log.js';

const CLEAR = '\r\u001b[2K';

function harness(isTty: boolean, options: { columns?: number } = {}) {
  const stderr: string[] = [];
  const logged: string[] = [];
  const logger: Logger = {
    info: (...args) => logged.push(args.join(' ')),
    debug: () => undefined,
    error: (...args) => logged.push(`ERROR ${args.join(' ')}`),
  };
  let clock = 0;
  const reporter = createProgressReporter({
    logger,
    writeStderr: (text) => stderr.push(text),
    isTty,
    columns: () => options.columns ?? 200,
    now: () => clock,
    logEveryMs: 10_000,
  });

  return {
    reporter,
    stderr,
    logged,
    advance: (ms: number) => (clock += ms),
    // The last painted line, spinner frame stripped.
    live: () => stderr.at(-1)!.replace(CLEAR, '').slice(2),
  };
}

const snapshot = (done: number, current: string | null) => ({
  done,
  total: 100,
  enriched: Math.floor(done / 2),
  returned: Math.floor(done / 2),
  skipped: 0,
  current,
});

describe('formatDuration', () => {
  it('keeps seconds under a minute and hours over an hour', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(90_000)).toBe('2m');
    expect(formatDuration(8_100_000)).toBe('2h 15m');
  });
});

describe('progress on a terminal', () => {
  it('redraws one line carrying counts, rate, ETA and the current track', () => {
    const h = harness(true);

    h.advance(10_000);
    h.reporter.update(snapshot(20, 'Midnight City — M83'));

    // Twenty tracks in ten seconds: 2/s, eighty left, forty seconds to go.
    expect(h.live()).toBe('20/100 · 20% · 10 landed · 2.0/s · 40s left · Midnight City — M83');
    // In place: cleared, no newline, so nothing scrolls.
    expect(h.stderr.at(-1)!.startsWith(CLEAR)).toBe(true);
    expect(h.stderr.join('')).not.toContain('\n');
    expect(h.logged).toEqual([]);
  });

  it('counts seconds per track when a track takes longer than a second', () => {
    const h = harness(true);

    h.advance(60_000);
    h.reporter.update(snapshot(25, null));

    expect(h.live()).toContain('2.4s each');
  });

  it('keeps the line moving between tracks so a slow run never looks hung', () => {
    vi.useFakeTimers();

    try {
      const h = harness(true);

      h.reporter.update(snapshot(1, 'Teardrop — Massive Attack'));
      const paints = h.stderr.length;

      h.advance(3000);
      vi.advanceTimersByTime(3000);

      expect(h.stderr.length).toBeGreaterThan(paints);
      expect(h.live()).toContain('Teardrop — Massive Attack');
      h.reporter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prints a note above the live line and puts the line back', () => {
    const h = harness(true);

    h.reporter.update(snapshot(10, 'Angel — Massive Attack'));
    h.reporter.note('chunk skipped (25 tracks stay pending): 503', 'error');

    expect(h.logged).toEqual(['ERROR chunk skipped (25 tracks stay pending): 503']);
    // Cleared before the note so it cannot land on top of the live line, then repainted.
    expect(h.stderr.at(-2)).toBe(CLEAR);
    expect(h.live()).toContain('10/100');
  });

  it('truncates to the terminal width rather than wrapping', () => {
    const h = harness(true, { columns: 30 });

    h.reporter.update(snapshot(10, 'A Very Long Track Title — And A Long Artist Name'));

    expect(h.stderr.at(-1)!.replace(CLEAR, '')).toHaveLength(30);
    expect(h.stderr.at(-1)!.endsWith('…')).toBe(true);
  });

  it('takes the line down on stop, leaving the terminal clean for the JSON', () => {
    const h = harness(true);

    h.reporter.update(snapshot(100, null));
    h.reporter.stop();

    expect(h.stderr.at(-1)).toBe(CLEAR);
  });
});

describe('progress when stderr is redirected', () => {
  it('logs plain lines with no control characters', () => {
    const h = harness(false);

    h.advance(10_000);
    h.reporter.update(snapshot(20, 'Midnight City — M83'));

    expect(h.stderr).toEqual([]);
    expect(h.logged).toEqual(['20/100 · 20% · 10 landed · 2.0/s · 40s left · Midnight City — M83']);
  });

  it('throttles so a per-track tick cannot flood the log', () => {
    const h = harness(false);

    h.reporter.update(snapshot(1, 'a'));

    for (let done = 2; done <= 9; done += 1) {
      h.advance(1000);
      h.reporter.update(snapshot(done, 'b'));
    }

    expect(h.logged).toHaveLength(1); // the first tick only; the rest are inside the window

    h.advance(5000);
    h.reporter.update(snapshot(10, 'c'));

    expect(h.logged).toHaveLength(2);
  });

  it('always logs the last tick, however recent the previous one', () => {
    const h = harness(false);

    h.reporter.update(snapshot(1, 'a'));
    h.advance(100);
    h.reporter.update(snapshot(100, 'z'));

    expect(h.logged).toHaveLength(2);
    expect(h.logged.at(-1)).toContain('100/100 · 100%');
  });

  it('stops without writing anything, since nothing was ever painted', () => {
    const h = harness(false);

    h.reporter.update(snapshot(100, null));
    h.reporter.stop();

    expect(h.stderr).toEqual([]);
  });
});
