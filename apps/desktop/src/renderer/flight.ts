// The arc a record flies along from the crate to the rail, as keyframes for
// the Web Animations API. Pure numbers in, transforms out.

export type Rect = { left: number; top: number; width: number };

// Enough frames that the compositor's straight lines between them read as a curve.
const FRAMES = 16;

/**
 * Keyframes moving a box drawn at `from` onto `to`: up over an arc whose
 * height grows with the distance, shrinking to size and spinning a little on the way.
 */
export function arcFrames(from: Rect, to: Rect): Keyframe[] {
  const dx = to.left - from.left + (to.width - from.width) / 2;
  const dy = to.top - from.top + (to.width - from.width) / 2;
  const lift = Math.min(220, 60 + Math.hypot(dx, dy) * 0.25);
  const scale = to.width / from.width;

  return Array.from({ length: FRAMES + 1 }, (_, i) => {
    const t = i / FRAMES;
    const x = dx * t;
    // A parabola through both ends, peaking `lift` above the straight line.
    const y = dy * t - lift * 4 * t * (1 - t);
    const s = 1 + (scale - 1) * t;
    const spin = Math.sin(t * Math.PI) * (dx >= 0 ? 8 : -8);

    return {
      offset: t,
      transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${spin.toFixed(2)}deg) scale(${s.toFixed(4)})`,
    };
  });
}
