import { expect, it } from 'vitest';
import { agoText, libraryLine } from '../src/renderer/library.js';

const now = Date.parse('2026-10-15T12:00:00Z');
const min = 60_000;

it('says how long ago the library was read', () => {
  expect(agoText(now - 20_000, now)).toBe('just now');
  expect(agoText(now - 5 * min, now)).toBe('5 min ago');
  expect(agoText(now - 3 * 60 * min, now)).toBe('3 h ago');
  expect(agoText(now - 30 * 60 * min, now)).toBe('yesterday');
  expect(agoText(now - 4 * 24 * 60 * min, now)).toBe('4 days ago');
});

it('reads a refresh as it goes and once it ends', () => {
  const read_at = now - 2 * min;

  expect(libraryLine({ read_at: null }, now)).toEqual({ text: 'Never read' });
  expect(libraryLine({ read_at, reading: true }, now).text).toBe('Reading your library…');
  expect(libraryLine({ read_at, measuring: { done: 10, of: 12 } }, now).text).toBe(
    'Measuring tempo and key · 10 of 12',
  );
  expect(libraryLine({ read_at, measured: 9, left: 0 }, now)).toEqual({
    text: 'Read 2 min ago · 9 measured',
  });
  expect(libraryLine({ read_at, measured: 0 }, now)).toEqual({ text: 'Read 2 min ago' });
  expect(libraryLine({ read_at, measured: 100, left: 4712 }, now).text).toBe(
    'Read 2 min ago · 100 measured, 4,712 to go',
  );
  expect(libraryLine({ read_at, failed: 'measure', error: 'x' }, now)).toEqual({
    text: "Read 2 min ago · couldn't measure",
    failed: true,
  });
  expect(libraryLine({ read_at, failed: 'read', error: 'x' }, now)).toEqual({
    text: "Couldn't read your library",
    failed: true,
  });
});
