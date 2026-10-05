// Geometry for the crate: how each sleeve stands, leans and shades given how
// far it is from the one in front. Pure numbers in, CSS transform values out.

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Spacing between sleeves for an edge of `size`: each top edge shows above the one in front. */
export const pitch = (size: number) => size * 0.078;

// The crate holds this many sleeves behind the front one; deeper ones are past its back wall.
export const DEPTH = 22;

/** Depth of a sleeve `d` slots behind the front one; the stack moves up as you flip. */
export const standZ = (d: number, size: number) => (DEPTH / 2 - d) * pitch(size);

/** Where the front wall stands, just ahead of the front sleeve. */
export const frontZ = (size: number) => (DEPTH * pitch(size)) / 2 + pitch(size) * 1.2 + size * 0.12;

/** Where the back wall stands. */
export const backZ = (size: number) => standZ(DEPTH, size) - pitch(size);

export type SleeveMotion = {
  slot: number; // where it stands in the list (fractional while shuffling)
  lift: number; // hover, in pixels
  hop: number; // 0..1 through a shuffle's hop
  out: number; // 0 in the crate, 1 lifted clean out (filtered away)
  pulled: number; // 0 in the crate, 1 pulled out and tipped toward you
};

export type Pose = { y: number; z: number; angle: number; shade: number; opacity: number };

/**
 * One sleeve, given the crate's position `pos` (the slot in front, fractional
 * while flipping) and `lean`, the tilt the flip's speed gives nearby sleeves.
 */
export function pose(
  s: SleeveMotion,
  pos: number,
  size: number,
  lean = 0,
  front?: { lift: number; pulled: number },
): Pose {
  const d = s.slot - pos;
  const flipped = smooth(clamp(-d, 0, 1));
  // Flipped sleeves fall forward against the front wall, older ones flatter under newer ones.
  const flat = -(58 + Math.min(Math.max(-d - 1, 0), 8) * 2.4);
  // Ones behind stand nearly upright, a little more tipped the further back they are.
  const upright = 3 + clamp(d, 0, 1) * 5 + clamp(d - 1, 0, 10) * 0.5;
  let angle = d >= 0 ? upright : lerp(3, flat, flipped);

  angle += lean * Math.exp(-Math.abs(d) * 0.85) * (d > -0.5 ? 1 : 0.35);

  // Flipped ones rest against the front wall, the oldest nearest it.
  let z = lerp(standZ(d, size), frontZ(size) - size * 0.06 + d * pitch(size) * 0.2, flipped);
  let y = -s.lift - Math.sin(s.hop * Math.PI) * size * 0.2 - s.out * size * 0.9;

  // Pulled out: it rises out of the bin and tips upright toward you.
  if (s.pulled > 0) {
    y -= s.pulled * size * 0.34;
    z += s.pulled * size * 0.22;
    angle = lerp(angle, -1, s.pulled);
  }

  // Deeper sleeves sit in the crate's shadow; the ones under a lifted front record darken too.
  let shade =
    d > 0.02 ? Math.min(0.84, 0.16 + d * 0.09) : 0.12 * flipped + (d < 0 ? 0.24 * flipped : 0);

  if (front && d > 0 && d < 1.6)
    shade += clamp(front.lift / (size * 0.08), 0, 1) * 0.22 + front.pulled * 0.3;

  return { y, z, angle, shade: Math.min(0.9, shade), opacity: 1 - s.out };
}

/** Only sleeves this close to the front are drawn; a library has thousands. */
export function visibleRange(pos: number, count: number): [number, number] {
  return [Math.max(0, Math.floor(pos) - 8), Math.min(count, Math.ceil(pos) + DEPTH)];
}

/** Where a flick comes to rest: carried by its speed, then onto a whole slot. */
export const flickTarget = (pos: number, velocity: number, count: number) =>
  clamp(Math.round(pos + clamp(velocity, -40, 40) * 0.22), 0, Math.max(0, count - 1));

/** Past either end a drag gives less and less, so the crate feels its walls. */
export function rubberBand(pos: number, count: number): number {
  const last = Math.max(0, count - 1);

  if (pos < 0) return -Math.pow(-pos, 0.6) * 0.35;

  if (pos > last) return last + Math.pow(pos - last, 0.6) * 0.35;

  return pos;
}

// One flip per this much scroll; a trackpad sends many small deltas.
export const WHEEL_STEP = 46;

/** Whole flips out of accumulated scroll, and the remainder to keep. */
export function wheelFlips(accumulated: number): { flips: number; rest: number } {
  const flips = Math.trunc(accumulated / WHEEL_STEP);

  return { flips: clamp(flips, -3, 3), rest: accumulated - flips * WHEEL_STEP };
}

/** The crate's counter; names the library's total when the crate holds only the first page. */
export const counterText = (cur: number, count: number, total: number, query: boolean) =>
  count === 0
    ? 'No records match'
    : `Record ${String(cur + 1).padStart(2, '0')} of ${count}${total > count ? ` (${total} ${query ? 'match' : 'in library'})` : query ? ' matching' : ''}`;
