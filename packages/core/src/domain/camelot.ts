// Camelot notation: the same key written on a clock face. The number is a
// position on the circle of fifths and the letter is the mode (A minor,
// B major), so keys that sit next to each other mix cleanly — which is the
// only reason to carry it.

const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Where each half of the wheel starts: 8A is A minor (pitch class 9), 8B is
// C major (0). A fifth up is 7 semitones and advances one position.
const ORIGIN = { minor: 9, major: 0 };

const KEY = /^([A-G])([#b]?)\s+(major|minor)$/i;

/**
 * Camelot position for a key in standard notation ("F minor", "Db major"),
 * or null when the string is not one.
 *
 * A pure relabeling, so it holds whoever measured the key: an AcousticBrainz
 * key earns its position exactly as an analyzed one does.
 */
export function camelotFor(musicalKey: string | null | undefined): string | null {
  const match = musicalKey?.trim().match(KEY);

  if (match == null) return null;

  const accidental = match[2]!.toLowerCase();
  const offset = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
  const pitchClass = (SEMITONES[match[1]!.toUpperCase()]! + offset + 12) % 12;
  const mode = match[3]!.toLowerCase() === 'minor' ? 'minor' : 'major';
  const fifths = (((7 * (pitchClass - ORIGIN[mode])) % 12) + 12) % 12;

  return `${((7 + fifths) % 12) + 1}${mode === 'minor' ? 'A' : 'B'}`;
}
