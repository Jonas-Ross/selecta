import { expect, it } from 'vitest';
import {
  frameSprings,
  GROW,
  LIFT,
  rest,
  settled,
  SLIDE,
  SQUASH,
  stepSpring,
} from '../src/renderer/springs.js';

function run(config: typeof SLIDE, target: number, seconds: number, dt = 1 / 60) {
  let spring = rest(0);
  let peak = 0;

  for (let t = 0; t < seconds; t += dt) {
    spring = stepSpring(spring, target, config, dt);
    peak = Math.max(peak, spring.x);
  }

  return { spring, peak };
}

it('settles each spring on its target within a second', () => {
  for (const config of [SLIDE, LIFT, SQUASH, GROW]) {
    const { spring } = run(config, 1, 1.2);

    expect(settled(spring, 1)).toBe(true);
  }
});

it('slides with little overshoot and lets the squash bounce', () => {
  expect(run(SLIDE, 1, 1).peak).toBeLessThan(1.05);
  expect(run(SQUASH, 1, 1).peak).toBeGreaterThan(1.1);
});

it('stays stable through a long frame', () => {
  const { spring } = run(LIFT, 1, 2, 0.5);

  expect(Number.isFinite(spring.x)).toBe(true);
  expect(settled(spring, 1)).toBe(true);
});

it('does not call a spring settled while it is still moving', () => {
  expect(settled({ x: 1, v: 0.5 }, 1)).toBe(false);
  expect(settled({ x: 0.9, v: 0 }, 1)).toBe(false);
  expect(settled(rest(1), 1)).toBe(true);
});

it('steps a frame of springs and reports whether any is still moving', () => {
  const frame = frameSprings(false, 1 / 60);
  const next = frame.step(rest(0), 1, SLIDE);

  expect(next.x).toBeGreaterThan(0);
  expect(frame.moving).toBe(true);
  expect(frameSprings(false, 1 / 60).step(rest(1), 1, SLIDE)).toEqual(rest(1));
});

it('snaps every spring to its target under reduced motion', () => {
  const frame = frameSprings(true, 1 / 60);

  expect(frame.step({ x: 0, v: 3 }, 1, SLIDE)).toEqual(rest(1));
  expect(frame.moving).toBe(false);
});
