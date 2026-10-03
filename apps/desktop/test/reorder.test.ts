import { expect, it } from 'vitest';
import { dropSlot, slotUnder, withMoved } from '../src/renderer/reorder.js';
import { move } from '../src/renderer/state.js';

it('picks the slot under the record and keeps it on the rail', () => {
  expect(slotUnder(2.4, 5)).toBe(2);
  expect(slotUnder(2.6, 5)).toBe(3);
  expect(slotUnder(-0.6, 5)).toBe(0);
  expect(slotUnder(9, 5)).toBe(4);
});

it('carries a thrown record a little further', () => {
  expect(dropSlot(2.4, 0, 5)).toBe(2);
  expect(dropSlot(2.4, 3, 5)).toBe(3);
  expect(dropSlot(2.4, -3, 5)).toBe(2);
  expect(dropSlot(2.4, 400, 5)).toBe(3);
});

// The rail names the entry standing at the drop slot as the edit queue's move target.
it('matches the order the edit queue will write for the same move', () => {
  const ids = ['a', 'b', 'c', 'd'];

  for (const id of ids)
    for (let to = 0; to < ids.length; to++)
      expect(move(ids, ids.indexOf(id), to)).toEqual(withMoved(ids, id, to));
});
