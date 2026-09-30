// The Camelot wheel: keys numbered 1 to 12 round a clock, A for minor and B for major.
const NOTES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

const majorPc = (n) => ((((n - 8) * 7) % 12) + 12) % 12;

export const camelotName = (n, ring) =>
  ring === 'B' ? `${NOTES[majorPc(n)]} major` : `${NOTES[(majorPc(n) + 9) % 12]} minor`;
export const parseCamelot = (c) => ({ n: parseInt(c, 10), ring: c.slice(-1) });
export const wheelStep = (n, d) => ((((n - 1 + d) % 12) + 12) % 12) + 1;
