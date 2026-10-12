import { expect, it } from 'vitest';
import { around, auditionPlan, swapEntries, swappedIn } from '../src/renderer/replace.js';
import type { Row } from '../src/renderer/state.js';

const row = (n: number, duration_seconds?: number): Row => ({
  entry_id: `E-${n}`,
  track_id: `T-${n}`,
  ...(duration_seconds !== undefined && { duration_seconds }),
});
const items = [row(1, 300), row(2, 240), row(3)];
const pick = { track_id: 'P', duration_seconds: 360 };

it('finds a record and its neighbours, and nothing once it has left', () => {
  expect(around(items, 'E-2')).toEqual({ at: 1, prev: items[0], row: items[1], next: items[2] });
  expect(around(items, 'E-1')).toMatchObject({ at: 0, prev: undefined, next: items[1] });
  expect(around(items, 'E-9')).toBeUndefined();
});

it('auditions a pick between its neighbours: a third in, or a minute before each join', () => {
  const middle = around(items, 'E-2')!;

  expect(auditionPlan(middle, pick, 'hear')).toEqual({
    track_ids: ['T-1', 'P', 'T-3'],
    index: 1,
    position: 120,
  });
  expect(auditionPlan(middle, pick, 'in')).toEqual({
    track_ids: ['T-1', 'P', 'T-3'],
    index: 0,
    position: 240,
  });
  expect(auditionPlan(middle, pick, 'out')).toEqual({
    track_ids: ['T-1', 'P', 'T-3'],
    index: 1,
    position: 300,
  });
});

it('has no join to hear at either end of the set, or before a record of unknown length', () => {
  const first = around(items, 'E-1')!;
  const last = around(items, 'E-3')!;

  expect(auditionPlan(first, pick, 'hear')).toEqual({
    track_ids: ['P', 'T-2'],
    index: 0,
    position: 120,
  });
  expect(auditionPlan(first, pick, 'in')).toBeUndefined();
  expect(auditionPlan(last, pick, 'out')).toBeUndefined();
  expect(auditionPlan(around(items, 'E-2')!, { track_id: 'P' }, 'out')).toBeUndefined();
  expect(auditionPlan(around(items, 'E-2')!, { track_id: 'P' }, 'hear')).toEqual({
    track_ids: ['T-1', 'P', 'T-3'],
    index: 1,
  });
  expect(auditionPlan({ prev: row(1), next: undefined }, pick, 'in')).toBeUndefined();
});

it('swaps one entry for a new one in place, and finds it again after the edit', () => {
  const entries = items.map(({ entry_id, track_id }) => ({ entry_id, track_id }));

  expect(swapEntries(entries, 'E-2', 'P')).toEqual([
    { entry_id: 'E-1', track_id: 'T-1' },
    { track_id: 'P' },
    { entry_id: 'E-3', track_id: 'T-3' },
  ]);
  expect(swapEntries(entries, 'E-9', 'P')).toBeUndefined();

  const after = [entries[0]!, { entry_id: 'E-NEW', track_id: 'P' }, entries[2]!];

  expect(swappedIn(after, new Set(['E-1', 'E-2', 'E-3']), 'P')).toBe('E-NEW');
  expect(swappedIn(entries, new Set(['E-1', 'E-2', 'E-3']), 'P')).toBeUndefined();
});
