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
  join: number;
  key: Box;
  bands: { B: Box; A: Box };
};

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

// Twelve rows per wheel ring; a ring the draft never touches shrinks to a labelled strip.
const KEY_ROW = 5;
const EMPTY_BAND = 20;
const BAND_GAP = 8;

export type Rings = { A: boolean; B: boolean };

/** Which wheel rings, minor (A) and major (B), the draft's keys sit on. */
export function keyRings(camelots: (string | undefined)[]): Rings {
  const modes = new Set(camelots.map((camelot) => parseCamelot(camelot)?.mode));

  return { A: modes.has('A'), B: modes.has('B') };
}

/**
 * Lanes are sized by what they hold and records take the rest of the height,
 * up to a size past which too few fit across. What still remains is air,
 * mostly below so the rail sits high.
 */
export function shelfLayout(height: number, rings: Rings): Shelf {
  const tempoH = clamp(height * 0.17, 84, 150);
  const bandB = rings.B ? 12 * KEY_ROW : EMPTY_BAND;
  const bandA = rings.A ? 12 * KEY_ROW : EMPTY_BAND;
  const keyH = bandB + BAND_GAP + bandA;
  // Lane title, tick row, captions, joins with the key title, bottom margin.
  const fixed = 28 + 24 + 46 + 54 + 16;
  const size = Math.round(clamp(height - fixed - tempoH - keyH - 40, 92, 212));
  // Wide enough for a two-line join marker between neighbours.
  const gap = Math.round(clamp(size * 0.34, 48, 64));
  const spare = Math.max(0, height - fixed - tempoH - keyH - size);
  const top = 28 + spare * 0.3;
  const rail = top + tempoH + 24 + size;
  const keyTop = rail + 46 + 54;

  return {
    size,
    gap,
    step: size + gap,
    tempo: { top, height: tempoH },
    tick: top + tempoH + 5,
    rail,
    join: rail + 46,
    key: { top: keyTop, height: keyH },
    bands: {
      B: { top: keyTop, height: bandB },
      A: { top: keyTop + bandB + BAND_GAP, height: bandA },
    },
  };
}

/** How visible a label is when `room` pixels are free: gone below `need`, whole `span` later. */
export const labelFade = (room: number, need: number, span: number) =>
  clamp((room - need) / span, 0, 1);

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

/** The row for a Camelot position, 12 at the top of its ring, or undefined when there is none. */
export function keyY(camelot: string | undefined, bands: Shelf['bands']): number | undefined {
  const position = parseCamelot(camelot);

  if (!position) return;

  const band = bands[position.mode];

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
