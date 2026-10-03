import { expect, it } from 'vitest';
import {
  bpmScale,
  fitSize,
  formatClock,
  keyBands,
  keyY,
  shelfLayout,
  startTimes,
  stepPath,
  tempoY,
} from '../src/renderer/lanes.js';

it('pads the tempo scale around the draft and keeps a flat set readable', () => {
  const scale = bpmScale([118, undefined, 126, 122]);

  expect(scale.lo).toBeLessThan(118);
  expect(scale.hi).toBeGreaterThan(126);
  expect(scale.labels).toEqual([scale.hi, Math.round((scale.lo + scale.hi) / 2), scale.lo]);
  expect(scale.grid.every((value) => value >= scale.lo && value <= scale.hi)).toBe(true);

  const flat = bpmScale([124, 124]);

  expect(flat.hi - flat.lo).toBeGreaterThanOrEqual(8);
  expect(flat.lo).toBeLessThan(124);
  expect(flat.hi).toBeGreaterThan(124);
  expect(bpmScale([undefined])).toMatchObject({ lo: 100, hi: 130 });
});

it('puts faster tempos higher, inside the lane', () => {
  const scale = bpmScale([118, 126]);
  const box = { top: 100, height: 80 };

  expect(tempoY(126, scale, box)).toBeLessThan(tempoY(118, scale, box));
  expect(tempoY(500, scale, box)).toBeGreaterThanOrEqual(box.top);
  expect(tempoY(1, scale, box)).toBeLessThanOrEqual(box.top + box.height);
});

it('draws B above A, 12 at the top of each band, and nothing for a missing key', () => {
  const box = { top: 0, height: 208 };
  const { A, B } = keyBands(box);

  expect(B.top).toBeLessThan(A.top);
  expect(keyY('8B', box)!).toBeLessThan(B.top + B.height);
  expect(keyY('8A', box)!).toBeGreaterThan(A.top);
  expect(keyY('12A', box)!).toBeLessThan(keyY('1A', box)!);
  expect(keyY(undefined, box)).toBeUndefined();
  expect(keyY('C minor', box)).toBeUndefined();
});

it('breaks the step line at a missing value instead of bridging it', () => {
  const step = stepPath([
    { x0: 0, x1: 10, y: 5 },
    { x0: 10, x1: 20, y: 8 },
    { x0: 20, x1: 30 },
    { x0: 30, x1: 40, y: 2 },
  ]);

  expect(step.d).toBe('M0 5H10L10 5L10 8H20M30 2H40');
  expect(step.gaps).toEqual([{ x0: 20, x1: 30 }]);
  expect(step.caps).toBe('M20 4V12M30 -2V6');
  expect(step.hot).toBe('');
});

it('traces the record in hand and the risers either side of it', () => {
  const step = stepPath([
    { x0: 0, x1: 10, y: 5 },
    { x0: 10, x1: 20, y: 8, hot: true },
    { x0: 20, x1: 30, y: 6 },
  ]);

  expect(step.hot).toBe('M10 5V8M10 8H20M20 8V6');
});

it('starts each record after the known lengths before it', () => {
  expect(startTimes([60, undefined, 30, 10])).toEqual([
    { seconds: 0, partial: false },
    { seconds: 60, partial: false },
    { seconds: 60, partial: true },
    { seconds: 90, partial: true },
  ]);
  expect(formatClock(391)).toBe('6:31');
  expect(formatClock(3725)).toBe('1:02:05');
});

it('shrinks records to fit the set, then scrolls, and stacks the bands in order', () => {
  const few = fitSize(1088, 780, 4);
  const many = fitSize(1088, 780, 40);

  expect(few).toBeGreaterThan(many);
  // A tall rail keeps records readable and scrolls instead; a short one shrinks to the floor.
  expect(many).toBe(Math.round(780 * 0.14));
  expect(fitSize(1088, 400, 40)).toBe(92);
  expect(few).toBeLessThanOrEqual(150);

  for (const size of [few, many]) {
    const shelf = shelfLayout(780, size);

    expect(shelf.step).toBe(shelf.size + shelf.gap);
    expect(shelf.tempo.top + shelf.tempo.height).toBeLessThan(shelf.rail - shelf.size);
    expect(shelf.caption).toBeGreaterThan(shelf.rail);
    expect(shelf.join).toBeGreaterThan(shelf.caption);
    expect(shelf.key.top).toBeGreaterThan(shelf.join);
    expect(shelf.key.top + shelf.key.height).toBeLessThanOrEqual(780);
  }
});
