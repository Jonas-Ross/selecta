import { describe, expect, it } from 'vitest';
import { digStep, ghostCount, nextPull, runTools } from '../src/renderer/digging.js';

describe('runTools', () => {
  it('counts only calls since the latest request, so a retry starts fresh', () => {
    const log = [
      { kind: 'you' as const, text: 'Warm-up', brief: true as const },
      { kind: 'tool' as const, text: 'search' },
      { kind: 'error' as const, text: 'failed' },
      { kind: 'you' as const, text: 'Warm-up' },
    ];

    expect(runTools(log)).toEqual([]);
    expect(runTools([...log, { kind: 'tool', text: 'library overview' }])).toEqual([
      'library overview',
    ]);
  });
});

describe('digStep', () => {
  it('names known tools in plain words and starts on the brief', () => {
    expect(digStep()).toBe('reading your brief');
    expect(digStep('library overview')).toBe('reading your library');
    expect(digStep('search')).toBe('searching your crates');
  });

  it('passes an unknown tool through rather than inventing a step', () => {
    expect(digStep('something new')).toBe('something new');
  });
});

describe('ghostCount', () => {
  it('fills the visible rail with whole slots', () => {
    // As RailRecord places them: PAD 12, half a gap, then 4 slots of 100 with 40 gaps end at 12 + 20 + 3*140 + 100 = 552.
    expect(ghostCount(552, 140, 40)).toBe(4);
    expect(ghostCount(551, 140, 40)).toBe(3);
  });

  it('keeps one on a narrow rail and caps a wide one', () => {
    expect(ghostCount(50, 140, 40)).toBe(1);
    expect(ghostCount(10_000, 140, 40)).toBe(10);
  });
});

describe('nextPull', () => {
  it('never pulls the same sleeve twice in a row', () => {
    for (const count of [2, 3, 6, 10])
      for (let at = 0; at < count; at++)
        for (let turn = 0; turn < 12; turn++) {
          const next = nextPull(at, turn, count);

          expect(next).not.toBe(at);
          expect(next).toBeGreaterThanOrEqual(0);
          expect(next).toBeLessThan(count);
        }
  });

  it('stays on the only sleeve there is', () => {
    expect(nextPull(0, 5, 1)).toBe(0);
  });
});
