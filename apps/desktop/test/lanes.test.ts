import { expect, it } from 'vitest';
import {
  bpmScale,
  formatClock,
  keyRings,
  keyY,
  labelFade,
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

it('draws B above A, 12 at the top of each ring, and nothing for a missing key', () => {
  const { bands } = shelfLayout(800, { A: true, B: true });

  expect(bands.B.top).toBeLessThan(bands.A.top);
  expect(keyY('8B', bands)!).toBeLessThan(bands.B.top + bands.B.height);
  expect(keyY('8A', bands)!).toBeGreaterThan(bands.A.top);
  expect(keyY('12A', bands)!).toBeLessThan(keyY('1A', bands)!);
  expect(keyY(undefined, bands)).toBeUndefined();
  expect(keyY('C minor', bands)).toBeUndefined();
});

it('shrinks a ring the draft never uses and gives the height to the records', () => {
  expect(keyRings(['8A', undefined, '9A'])).toEqual({ A: true, B: false });
  expect(keyRings(['10B', 'nope'])).toEqual({ A: false, B: true });

  const both = shelfLayout(560, { A: true, B: true });
  const minorOnly = shelfLayout(560, { A: true, B: false });

  expect(minorOnly.bands.B.height).toBeLessThan(both.bands.B.height);
  expect(minorOnly.bands.A.height).toBe(both.bands.A.height);
  expect(minorOnly.size).toBeGreaterThan(both.size);
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

it('stacks the bands in order inside the rail area, records large but bounded', () => {
  for (const height of [520, 812, 1400]) {
    const shelf = shelfLayout(height, { A: true, B: true });

    expect(shelf.size).toBeGreaterThanOrEqual(92);
    expect(shelf.size).toBeLessThanOrEqual(212);
    expect(shelf.step).toBe(shelf.size + shelf.gap);
    expect(shelf.tempo.top + shelf.tempo.height).toBeLessThan(shelf.rail - shelf.size);
    expect(shelf.join).toBeGreaterThan(shelf.rail);
    expect(shelf.key.top).toBeGreaterThan(shelf.join);
    expect(shelf.bands.A.top + shelf.bands.A.height).toBe(shelf.key.top + shelf.key.height);

    if (height >= 812) expect(shelf.key.top + shelf.key.height).toBeLessThanOrEqual(height);
  }

  expect(shelfLayout(812, { A: true, B: true }).size).toBe(212);
});

it('fades a label out as its room drops below what it needs', () => {
  expect(labelFade(200, 100, 20)).toBe(1);
  expect(labelFade(110, 100, 20)).toBe(0.5);
  expect(labelFade(60, 100, 20)).toBe(0);
});

it('tightens the lanes under the crate before records drop below a readable size', () => {
  const short = shelfLayout(420, { A: true, B: true });

  expect(short.size).toBeGreaterThanOrEqual(64);
  expect(short.key.top + short.key.height).toBeLessThanOrEqual(420);
  expect(short.bands.A.height).toBeLessThan(shelfLayout(800, { A: true, B: true }).bands.A.height);
});
