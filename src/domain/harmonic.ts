// How two Camelot positions relate. The wheel is the circle of fifths written
// as a clock, so one step around it changes a single note and the A/B pair on
// a number is the relative minor/major — that geometry is the whole fact.
// Which relations count as a clean mix is the reader's call, not Selecta's.

export type HarmonicRelation =
  | 'same' // identical position
  | 'adjacent' // one step either way, a fifth apart
  | 'relative' // the A/B pair on one number
  | 'energy_boost' // two steps up, same mode
  | 'distant' // anything else
  | 'unknown'; // at least one side has no position

export type CamelotPosition = {
  number: number; // 1-12, clockwise round the wheel
  mode: 'A' | 'B'; // A is minor, B is major
};

const CAMELOT = /^([1-9]|1[0-2])([AB])$/;

/** A parsed wheel position, or null when the string is not one. */
export function parseCamelot(value: string | null | undefined): CamelotPosition | null {
  const match = value?.trim().toUpperCase().match(CAMELOT);

  if (match == null) return null;

  return { number: Number(match[1]), mode: match[2] as 'A' | 'B' };
}

/**
 * How the second wheel position sits relative to the first. Direction matters:
 * two steps up is a recognised move where two steps down is not, so swapping
 * the arguments can change the answer.
 */
export function harmonicRelation(
  from: string | null | undefined,
  to: string | null | undefined,
): HarmonicRelation {
  const a = parseCamelot(from);
  const b = parseCamelot(to);

  if (a == null || b == null) return 'unknown';

  const steps = (((b.number - a.number) % 12) + 12) % 12;

  if (a.mode !== b.mode) return steps === 0 ? 'relative' : 'distant';

  switch (steps) {
    case 0:
      return 'same';
    case 1:
    case 11:
      return 'adjacent';
    case 2:
      return 'energy_boost';
    default:
      return 'distant';
  }
}
