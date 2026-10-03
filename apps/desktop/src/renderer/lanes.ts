// Geometry for the rail: where records stand, and the tempo and key lanes drawn
// above and below them. Pure numbers in, pixels and SVG path strings out.
import { parseCamelot } from '@selecta/core/domain/harmonic.js';

export type Box = { top: number; height: number };

/** Left gutter for lane titles and axis numbers. */
export const GUTTER = 56;
/** Space before the first slot, so the first step line has a visible start. */
export const PAD = 12;

export type Shelf = {
  size: number; // record edge
  gap: number; // between records
  step: number; // one slot: a record and its gap
  tempo: Box;
  tick: number; // y of the set-time labels
  rail: number; // y of the rail the records stand on
  caption: number;
  join: number;
  key: Box;
};

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/**
 * Records shrink to fit the whole set in view, down to a size that still
 * reads; past that the rail scrolls. Lanes take what height is left, capped
 * so a tall window doesn't stretch a few BPM into a cliff.
 */
export function shelfLayout(width: number, height: number, count: number): Shelf {
  const room = Math.max(0, width - GUTTER - PAD * 2);
  const fit = room / Math.max(1, count) - 40;
  const size = Math.round(clamp(Math.min(fit, height * 0.19), 92, 150));
  // Wide enough for a two-line join marker between neighbours.
  const gap = Math.round(clamp(size * 0.42, 40, 60));
  const fixed = 28 + 24 + size + 46 + 54 + 16;
  const spare = Math.max(0, height - fixed);
  const tempoH = Math.round(clamp(spare * 0.42, 64, 150));
  const keyH = Math.round(clamp(spare * 0.5, 96, 196));
  // Whatever the caps leave goes above the block, a little more than below.
  const top = Math.round(Math.max(0, (spare - tempoH - keyH) * 0.42)) + 28;
  const rail = top + tempoH + 24 + size;

  return {
    size,
    gap,
    step: size + gap,
    tempo: { top, height: tempoH },
    tick: top + tempoH + 5,
    rail,
    caption: rail + 10,
    join: rail + 46,
    key: { top: rail + 46 + 54, height: keyH },
  };
}

/** Left edge of slot `pos` (fractional while animating). */
export const slotX = (pos: number, step: number) => PAD + pos * step;

export type BpmScale = { lo: number; hi: number; labels: number[]; grid: number[] };

/** The draft's own tempo range, padded, so small steps between tracks stay visible. */
export function bpmScale(values: (number | undefined)[]): BpmScale {
  const known = values.filter((value): value is number => value !== undefined);
  let lo = 100;
  let hi = 130;

  if (known.length) {
    const min = Math.min(...known);
    const max = Math.max(...known);
    const pad = Math.max(2, (max - min) * 0.12);

    lo = Math.floor(min - pad);
    hi = Math.ceil(max + pad);

    // A set at one tempo still gets a lane with room above and below the line.
    if (hi - lo < 8) {
      const grow = (8 - (hi - lo)) / 2;

      lo = Math.floor(lo - grow);
      hi = Math.ceil(hi + grow);
    }
  }

  const every = [1, 2, 5, 10, 20, 50].find((step) => (hi - lo) / step <= 8) ?? 100;
  const grid: number[] = [];

  for (let value = Math.ceil(lo / every) * every; value <= hi; value += every) grid.push(value);

  return { lo, hi, labels: [hi, Math.round((lo + hi) / 2), lo], grid };
}

export function tempoY(bpm: number, scale: BpmScale, box: Box): number {
  const share = (clamp(bpm, scale.lo, scale.hi) - scale.lo) / (scale.hi - scale.lo);

  return box.top + 4 + (box.height - 8) * (1 - share);
}

/** B (major) above A (minor), each split into twelve rows with 12 at the top. */
export function keyBands(box: Box): { B: Box; A: Box } {
  const band = (box.height - 8) / 2;

  return { B: { top: box.top, height: band }, A: { top: box.top + band + 8, height: band } };
}

/** The row for a Camelot position, or undefined when there is none to draw. */
export function keyY(camelot: string | undefined, box: Box): number | undefined {
  const position = parseCamelot(camelot);

  if (!position) return;

  const band = keyBands(box)[position.mode];

  return band.top + (12 - position.number + 0.5) * (band.height / 12);
}

export type Segment = { x0: number; x1: number; y?: number; hot?: boolean };

export type Step = {
  d: string; // the line
  hot: string; // the parts that move with the record in hand, traced again
  caps: string; // short ticks where the line breaks for a missing value
  gaps: { x0: number; x1: number }[]; // hatched "not measured" spans
};

const f = (value: number) => (Math.round(value * 10) / 10).toString();

/**
 * A step line through segments in order. A missing value breaks it: the pen
 * lifts and the span is reported as a gap, never bridged or interpolated.
 */
export function stepPath(segments: Segment[]): Step {
  const out: Step = { d: '', hot: '', caps: '', gaps: [] };
  let pen: { x: number; y: number; hot: boolean } | undefined;
  let broke = false;

  for (const { x0, x1, y, hot = false } of segments) {
    if (y === undefined) {
      if (pen) out.caps += `M${f(pen.x)} ${f(pen.y - 4)}V${f(pen.y + 4)}`;

      pen = undefined;
      broke = true;
      out.gaps.push({ x0, x1 });
      continue;
    }

    if (pen) {
      out.d += `L${f(x0)} ${f(pen.y)}L${f(x0)} ${f(y)}`;

      if (hot || pen.hot) out.hot += `M${f(x0)} ${f(pen.y)}V${f(y)}`;
    } else {
      out.d += `M${f(x0)} ${f(y)}`;

      if (broke) out.caps += `M${f(x0)} ${f(y - 4)}V${f(y + 4)}`;
    }

    out.d += `H${f(x1)}`;

    if (hot) out.hot += `M${f(x0)} ${f(y)}H${f(x1)}`;

    pen = { x: x1, y, hot };
  }

  return out;
}

/** When each record starts, from the known lengths before it; partial once one is unknown. */
export function startTimes(durations: (number | undefined)[]) {
  let seconds = 0;
  let partial = false;

  return durations.map((duration) => {
    const start = { seconds, partial };

    if (duration === undefined) partial = true;
    else seconds += duration;

    return start;
  });
}

export function formatClock(seconds: number): string {
  const whole = Math.round(seconds);
  const s = String(whole % 60).padStart(2, '0');

  if (whole < 3600) return `${Math.floor(whole / 60)}:${s}`;

  return `${Math.floor(whole / 3600)}:${String(Math.floor(whole / 60) % 60).padStart(2, '0')}:${s}`;
}
