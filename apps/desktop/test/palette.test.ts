import { expect, it, vi } from 'vitest';
import { pickPalette } from '../src/renderer/palette.js';

// The module reads artwork through window.selecta, which a node test has none of.
vi.mock('../src/renderer/api.js', () => ({ selecta: { call: vi.fn() } }));

/** RGBA pixels: each [r, g, b] repeated `n` times. */
function pixels(...runs: [number, number, number, number][]): Uint8ClampedArray {
  return new Uint8ClampedArray(
    runs.flatMap(([r, g, b, n]) => Array.from({ length: n }, () => [r, g, b, 255]).flat()),
  );
}

const hueOf = (hsl: string) => Number(/hsl\((\d+)/.exec(hsl)![1]);

it('takes the strongest hue first and a distinct second one', () => {
  const palette = pickPalette(pixels([255, 40, 160, 300], [40, 220, 110, 120], [10, 10, 12, 500]))!;

  expect(hueOf(palette.a)).toBeGreaterThan(310);
  expect(hueOf(palette.b)).toBeGreaterThan(130);
  expect(hueOf(palette.b)).toBeLessThan(160);
});

it('lifts dark art to the same lightness as bright art', () => {
  const dark = pickPalette(pixels([90, 20, 30, 100]))!;
  const bright = pickPalette(pixels([250, 120, 130, 100]))!;

  expect(dark.a.endsWith(' 66%)')).toBe(true);
  expect(bright.a.endsWith(' 66%)')).toBe(true);
});

it('uses one colour twice when the art has only one', () => {
  const palette = pickPalette(pixels([30, 90, 220, 200], [0, 0, 0, 200]))!;

  expect(palette.b).toBe(palette.a);
});

it('ignores a faint second hue', () => {
  const palette = pickPalette(pixels([30, 90, 220, 400], [230, 120, 20, 10]))!;

  expect(palette.b).toBe(palette.a);
});

it('leaves mostly grey art untinted', () => {
  expect(pickPalette(pixels([128, 128, 128, 500], [20, 20, 20, 500], [200, 60, 60, 5]))).toBe(
    undefined,
  );
  expect(pickPalette(new Uint8ClampedArray(0))).toBe(undefined);
});

it('skips transparent pixels', () => {
  const palette = pickPalette(
    new Uint8ClampedArray([
      ...Array.from({ length: 50 }, () => [255, 0, 0, 0]).flat(),
      ...Array.from({ length: 50 }, () => [0, 0, 255, 255]).flat(),
    ]),
  )!;

  expect(hueOf(palette.a)).toBeGreaterThan(220);
  expect(palette.b).toBe(palette.a);
});
