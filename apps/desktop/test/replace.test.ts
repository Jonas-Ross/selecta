import { expect, it, vi } from 'vitest';
import {
  around,
  auditionPlan,
  poll,
  site,
  swapEdit,
  swapEntries,
} from '../src/renderer/replace.js';
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

it('names the spot picks were chosen for by the record and the tracks either side', () => {
  const before = site(around(items, 'E-2')!);

  expect(site(around([...items, row(4)], 'E-2')!)).toBe(before);
  expect(site(around([items[0]!, items[1]!, row(4)], 'E-2')!)).not.toBe(before);
  expect(site(around([items[0]!, row(5), items[1]!, items[2]!], 'E-2')!)).not.toBe(before);
});

it('auditions a pick between its neighbours: a third in, or the lead before each join', () => {
  const middle = around(items, 'E-2')!;

  expect(auditionPlan(middle, pick, 'hear', 60)).toEqual({
    track_ids: ['T-1', 'P', 'T-3'],
    index: 1,
    position: 120,
  });
  expect(auditionPlan(middle, pick, 'in', 60)).toEqual({
    track_ids: ['T-1', 'P', 'T-3'],
    index: 0,
    position: 240,
  });
  expect(auditionPlan(middle, pick, 'out', 60)).toEqual({
    track_ids: ['T-1', 'P', 'T-3'],
    index: 1,
    position: 300,
  });
});

it('has no join to hear at either end of the set, or before a record of unknown length', () => {
  const first = around(items, 'E-1')!;
  const last = around(items, 'E-3')!;

  expect(auditionPlan(first, pick, 'hear', 60)).toEqual({
    track_ids: ['P', 'T-2'],
    index: 0,
    position: 120,
  });
  expect(auditionPlan(first, pick, 'in', 60)).toBeUndefined();
  expect(auditionPlan(last, pick, 'out', 60)).toBeUndefined();
  expect(auditionPlan(around(items, 'E-2')!, { track_id: 'P' }, 'out', 60)).toBeUndefined();
  expect(auditionPlan(around(items, 'E-2')!, { track_id: 'P' }, 'hear', 60)).toEqual({
    track_ids: ['T-1', 'P', 'T-3'],
    index: 1,
  });
  expect(auditionPlan({ prev: row(1), next: undefined }, pick, 'in', 60)).toBeUndefined();
});

it('swaps one entry for a new one in place', () => {
  const entries = items.map(({ entry_id, track_id }) => ({ entry_id, track_id }));

  expect(swapEntries(entries, 'E-2', 'P')).toEqual([
    { entry_id: 'E-1', track_id: 'T-1' },
    { track_id: 'P' },
    { entry_id: 'E-3', track_id: 'T-3' },
  ]);
  expect(swapEntries(entries, 'E-9', 'P')).toBeUndefined();
});

it('finds the entry a swap added against the draft it applied to, not the rail before it', () => {
  // Another front end added P after the rail was drawn and before the swap applied.
  const base = [
    { entry_id: 'E-THEIRS', track_id: 'P' },
    ...items.map(({ entry_id, track_id }) => ({ entry_id, track_id })),
  ];
  const swapping = swapEdit('E-2', 'P');

  expect(swapping.added(base)).toBeUndefined();
  expect(swapping.change(base)).toHaveLength(4);

  const after = [base[0]!, base[1]!, { entry_id: 'E-NEW', track_id: 'P' }, base[3]!];

  expect(swapping.added(after)).toBe('E-NEW');
});

it('starts a join the chosen lead before the end', () => {
  expect(auditionPlan(around(items, 'E-2')!, pick, 'in', 30)).toMatchObject({
    index: 0,
    position: 270,
  });
});

it('polls until a read fails, then says so and stops rather than retrying', async () => {
  vi.useFakeTimers();

  const heard: number[] = [];
  const failed: string[] = [];
  let reads = 0;
  const read = () =>
    ++reads === 3 ? Promise.reject(new Error('Music went away.')) : Promise.resolve(reads);

  poll(
    read,
    1000,
    (n) => heard.push(n),
    (e) => failed.push(e.message),
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect(heard).toEqual([1, 2]);
  expect(failed).toEqual(['Music went away.']);
  expect(reads).toBe(3);

  // Stopped, a read already under way lands nowhere and none follows.
  const late: number[] = [];
  const stop = poll(
    () => Promise.resolve(7),
    1000,
    (n) => late.push(n),
    () => undefined,
  );

  await vi.advanceTimersByTimeAsync(500);
  stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(late).toEqual([]);
  vi.useRealTimers();
});
