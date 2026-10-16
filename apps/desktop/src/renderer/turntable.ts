// Listening mode's record: how fast it turns, how it winds up and down under
// the hand, the swell each bar, and where the dock slides. Pure, so the motion
// is testable without a frame loop.

const TAU = Math.PI * 2;

// A turn every four bars: calm, but quick enough to see the record is turning.
export const BEATS_PER_TURN = 16;
// A record with no measured tempo turns as if at a common dance tempo.
const FALLBACK_BPM = 120;
// Seconds to settle: a deck spins up quicker than it winds down, and a fling coasts longest.
const SPIN_UP = 0.6;
const SPIN_DOWN = 1.2;
const COAST = 1.4;
// Close enough to the tempo's speed that a fling counts as settled.
const SETTLED = 0.02;
// Radians a second below which a winding-down record simply stops, rather than creeping forever.
const STOP = 0.005;
// How long a bar's swell takes to fade, in beats.
const SWELL_BEATS = 1.6;

export type Spin = { angle: number; speed: number; flung: boolean };

/** Radians a second at the record's tempo. */
export function turnSpeed(bpm: number | undefined): number {
  return (TAU * (bpm || FALLBACK_BPM)) / (60 * BEATS_PER_TURN);
}

/** One frame of the record easing toward `target`: the tempo's speed while playing, still otherwise. */
export function coast(spin: Spin, dt: number, target: number): Spin {
  const tau = spin.flung ? COAST : target > spin.speed ? SPIN_UP : SPIN_DOWN;
  const eased = spin.speed + (target - spin.speed) * (1 - Math.exp(-dt / tau));
  const speed = target === 0 && Math.abs(eased) < STOP ? 0 : eased;

  return {
    angle: (spin.angle + speed * dt) % TAU,
    speed,
    flung: spin.flung && Math.abs(speed - target) > SETTLED,
  };
}

/** The shortest turn between two pointer angles, so a drag across ±π doesn't jump a whole turn. */
export function unwrap(delta: number): number {
  return delta - TAU * Math.round(delta / TAU);
}

/**
 * 1 on each bar's first beat, fading over the next beat or two. Bars count from the
 * record's start by Music's position; where the beat really lands isn't known.
 */
export function swell(position: number, bpm: number | undefined): number {
  if (!bpm || position < 0) return 0;

  const beat = 60 / bpm;

  return Math.exp(-(position % (4 * beat)) / (SWELL_BEATS * beat));
}

/** How warm the next record's band is: 0 until `lead` seconds from the end, then rising to 1. */
export function nearing(position: number, duration: number | undefined, lead: number): number {
  if (!duration || duration <= 0) return 0;

  return Math.min(1, Math.max(0, (position - (duration - lead)) / lead));
}

/** The dock's shift from the window's centre that puts the playing card's centre there. */
export function dockShift(index: number, tile: number, wide: number, gap: number): number {
  return -(index * (tile + gap) + wide / 2);
}

export type Rgb = [number, number, number];

/** A palette colour, `hsl(h s% l%)` as palette.ts writes it, in RGB 0–255; undefined for anything else. */
export function rgbOf(colour: string): Rgb | undefined {
  const m = /^hsl\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%\)$/.exec(colour);

  if (!m) return undefined;

  const [h, s, l] = [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;

    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };

  return [f(0), f(8), f(4)];
}

/** `from` moved toward `to` by `k`, 0 to 1, landing on `to` once within a step of it. */
export function mix(from: Rgb, to: Rgb, k: number): Rgb {
  const moved = from.map((v, i) => v + (to[i]! - v) * k) as Rgb;

  return moved.every((v, i) => Math.abs(v - to[i]!) < 1) ? to : moved;
}
