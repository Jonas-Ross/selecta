// Hand-rolled springs for the rail. Each value chases a target with a
// stiffness and a damping; the frame loop steps every one and stops when all settle.

export type Spring = { x: number; v: number };
export type SpringConfig = { stiffness: number; damping: number };

// Damping ratio ≈ 0.82: arrives quickly with only a hint of overshoot.
export const SLIDE: SpringConfig = { stiffness: 230, damping: 25 };
// Stiffer, so a picked record leaves the rail at once.
export const LIFT: SpringConfig = { stiffness: 320, damping: 24 };
// Underdamped on purpose: the landing squash bounces once.
export const SQUASH: SpringConfig = { stiffness: 340, damping: 11 };
// The new and leaving records grow and shrink a little slower than they slide.
export const GROW: SpringConfig = { stiffness: 180, damping: 24 };

// Long frames are split so a dropped frame can't make a stiff spring explode.
const MAX_DT = 1 / 240;

export function stepSpring(spring: Spring, target: number, config: SpringConfig, dt: number) {
  const steps = Math.max(1, Math.ceil(dt / MAX_DT));
  const h = dt / steps;
  let { x, v } = spring;

  for (let i = 0; i < steps; i++) {
    v += (config.stiffness * (target - x) - config.damping * v) * h;
    x += v * h;
  }

  return { x, v };
}

/** Close enough to stop animating: under a hundredth of a slot and barely moving. */
export const settled = (spring: Spring, target: number, eps = 0.002) =>
  Math.abs(spring.x - target) < eps && Math.abs(spring.v) < eps * 10;

export const rest = (x: number): Spring => ({ x, v: 0 });

/**
 * One frame's stepper: each `step` moves a spring toward its target, or snaps it
 * there under reduced motion, and `moving` says whether any has yet to settle.
 */
export function frameSprings(reduced: boolean, dt: number) {
  const frame = {
    moving: false,
    step(spring: Spring, target: number, config: SpringConfig): Spring {
      const next = reduced ? rest(target) : stepSpring(spring, target, config, dt);

      frame.moving ||= !settled(next, target);

      return next;
    },
  };

  return frame;
}
