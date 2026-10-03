// Where a dragged record lands, and where everything else stands meanwhile.

/** The slot under the record in hand. */
export const slotUnder = (pos: number, count: number) =>
  Math.min(count - 1, Math.max(0, Math.round(pos)));

/** On release the throw carries it a little further before it picks a slot. */
export const dropSlot = (pos: number, velocity: number, count: number) =>
  slotUnder(pos + Math.max(-12, Math.min(12, velocity)) * 0.09, count);

/** The order with `id` taken out and put back at `to`. */
export function withMoved(ids: string[], id: string, to: number): string[] {
  const rest = ids.filter((other) => other !== id);

  rest.splice(to, 0, id);

  return rest;
}

/**
 * The entry a move to `to` names as its target: `move` in the edit queue puts
 * the dragged entry where that one stands now.
 */
export const targetAt = (ids: string[], to: number) => ids[to];
