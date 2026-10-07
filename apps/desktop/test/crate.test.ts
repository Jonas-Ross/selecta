import { expect, it } from 'vitest';
import {
  counterText,
  flickTarget,
  frontZ,
  pose,
  rubberBand,
  standZ,
  visibleRange,
  wheelFlips,
  WHEEL_STEP,
} from '../src/renderer/crate.js';
import { arcFrames } from '../src/renderer/flight.js';
import { landingIndex } from '../src/renderer/reorder.js';

const still = { lift: 0, hop: 0, out: 0, pulled: 0 };

it('stands records behind the front one upright and lays flipped ones toward you', () => {
  const front = pose({ ...still, slot: 4 }, 4, 200);
  const behind = pose({ ...still, slot: 6 }, 4, 200);
  const flipped = pose({ ...still, slot: 2 }, 4, 200);

  expect(front.angle).toBeGreaterThan(0);
  expect(front.angle).toBeLessThan(10);
  expect(behind.z).toBeLessThan(front.z);
  expect(behind.shade).toBeGreaterThan(front.shade);
  expect(flipped.angle).toBeLessThan(-45);
  expect(flipped.z).toBeGreaterThan(front.z);
  expect(flipped.z).toBeLessThan(frontZ(200));
});

it('keeps the stack the same depth however far into the library you flip', () => {
  expect(pose({ ...still, slot: 250 }, 250, 200).z).toBe(pose({ ...still, slot: 0 }, 0, 200).z);
  expect(standZ(0, 200)).toBeGreaterThan(standZ(10, 200));
});

it('lifts a pulled record up and toward you, and shades the ones behind it', () => {
  const resting = pose({ ...still, slot: 3 }, 3, 200);
  const pulled = pose({ ...still, slot: 3, pulled: 1 }, 3, 200);
  const next = pose({ ...still, slot: 4 }, 3, 200);
  const nextShaded = pose({ ...still, slot: 4 }, 3, 200, 0, { lift: 0, pulled: 1 });

  expect(pulled.y).toBeLessThan(resting.y);
  expect(pulled.z).toBeGreaterThan(resting.z);
  expect(nextShaded.shade).toBeGreaterThan(next.shade);
  expect(pose({ ...still, slot: 3, out: 1 }, 3, 200).opacity).toBe(0);
});

it('draws only the records near the front', () => {
  expect(visibleRange(0, 300)).toEqual([0, 22]);
  expect(visibleRange(100, 300)).toEqual([92, 122]);
  expect(visibleRange(295, 300)).toEqual([287, 300]);
});

it('carries a flick on and rests it on a whole record inside the crate', () => {
  expect(flickTarget(3, 0, 40)).toBe(3);
  expect(flickTarget(3, 20, 40)).toBeGreaterThan(5);
  expect(flickTarget(3, -100, 40)).toBe(0);
  expect(flickTarget(38, 100, 40)).toBe(39);
  expect(rubberBand(5, 10)).toBe(5);
  expect(rubberBand(-2, 10)).toBeGreaterThan(-1);
  expect(rubberBand(12, 10)).toBeLessThan(10);
});

it('turns scroll into whole flips and keeps the remainder', () => {
  expect(wheelFlips(WHEEL_STEP - 1)).toEqual({ flips: 0, rest: WHEEL_STEP - 1 });
  expect(wheelFlips(WHEEL_STEP * 2 + 5)).toEqual({ flips: 2, rest: 5 });
  expect(wheelFlips(-WHEEL_STEP * 10).flips).toBe(-3);
});

it('counts records and names the library behind a capped crate', () => {
  expect(counterText(3, 40, 40, false)).toBe('Record 04 of 40');
  expect(counterText(0, 300, 3747, false)).toBe('Record 01 of 300 (3747 in library)');
  expect(counterText(0, 6, 6, true)).toBe('Record 01 of 6 matching');
  expect(counterText(0, 0, 0, true)).toBe('No records match');
});

it('flies a record along an arc that starts where it was and ends on its slot', () => {
  const frames = arcFrames({ left: 100, top: 100, width: 200 }, { left: 500, top: 400, width: 80 });
  const first = frames[0]!.transform as string;
  const last = frames[frames.length - 1]!.transform as string;
  const mid = frames[(frames.length / 2 - 0.5) | 0]!.transform as string;
  const y = (t: string) => Number(/translate\([^,]+, (-?[\d.]+)px/.exec(t)![1]);

  expect(first).toContain('translate(0.0px, 0.0px)');
  expect(first).toContain('scale(1.0000)');
  // The centre lands on the slot's centre, at the slot's size.
  expect(last).toContain(`translate(${(400 - 60).toFixed(1)}px, ${(300 - 60).toFixed(1)}px)`);
  expect(last).toContain('scale(0.4000)');
  expect(y(mid)).toBeLessThan(150);
});

it('holds a carried record in the gap it opened until the hand leaves it', () => {
  expect(landingIndex(2.3, 10)).toBe(2);
  expect(landingIndex(2.7, 10)).toBe(3);
  expect(landingIndex(3.8, 10, 3)).toBe(3);
  expect(landingIndex(4.7, 10, 3)).toBe(4);
  expect(landingIndex(1.2, 10, 3)).toBe(1);
  expect(landingIndex(-3, 10)).toBe(0);
  expect(landingIndex(40, 10, 3)).toBe(10);
});
