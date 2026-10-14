import { expect, it } from 'vitest';
import { cut } from '../src/renderer/groove.js';

const width = (b: { outer: number; inner: number }) => b.outer - b.inner;

it('cuts a band per record, outside in, as wide as the record is long', () => {
  const { bands } = cut(1200, 800, [
    { id: 'a', seconds: 300 },
    { id: 'b', seconds: 600 },
  ]);

  expect(bands.map((b) => b.id)).toEqual(['a', 'b']);
  expect(bands[0]!.outer).toBeGreaterThan(bands[1]!.outer);
  expect(width(bands[1]!) / width(bands[0]!)).toBeCloseTo(2);
  // The smooth run between tracks.
  expect(bands[0]!.inner - bands[1]!.outer).toBe(16);
});

it('cuts a record of unknown length as long as the average known one', () => {
  const { bands } = cut(1200, 800, [
    { id: 'a', seconds: 200 },
    { id: 'b' },
    { id: 'c', seconds: 400 },
  ]);

  expect(width(bands[1]!)).toBeCloseTo((width(bands[0]!) + width(bands[2]!)) / 2);
});

it('spans the window from its farthest corner to below its bottom edge', () => {
  const { cx, cy, bands } = cut(1200, 800, [{ id: 'a', seconds: 1 }]);

  expect(Math.hypot(1200 - cx, cy)).toBeLessThan(bands[0]!.outer);
  expect(cy - bands[0]!.inner).toBeGreaterThan(800);
});

it('narrows the gaps on a long draft so every record keeps grooves', () => {
  const records = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, seconds: 240 }));
  const { bands, rings } = cut(1200, 800, records);

  expect(bands).toHaveLength(500);

  for (const band of bands)
    expect(rings.some((r) => r.r <= band.outer && r.r > band.inner)).toBe(true);
});

it('cuts one band across a side with no records', () => {
  expect(cut(1200, 800, []).bands).toHaveLength(1);
});

it('keeps every groove inside its band, and a moved record keeps its cut', () => {
  const records = [
    { id: 'a', seconds: 300 },
    { id: 'b', seconds: 300 },
  ];
  const before = cut(1200, 800, records);
  const after = cut(1200, 800, [...records].reverse());
  const pattern = (c: typeof before, id: string) => {
    const band = c.bands.find((b) => b.id === id)!;

    return c.rings.filter((r) => r.r <= band.outer && r.r > band.inner).map((r) => r.loud);
  };

  for (const r of before.rings)
    expect(before.bands.some((b) => r.r <= b.outer && r.r > b.inner)).toBe(true);

  expect(pattern(after, 'a')).toEqual(pattern(before, 'a'));
  expect(pattern(before, 'a')).not.toEqual(pattern(before, 'b'));
});
