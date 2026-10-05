// Where a dragged record lands, and where everything else stands meanwhile.

/** The slot under the record in hand. */
export const slotUnder = (pos: number, count: number) =>
  Math.min(count - 1, Math.max(0, Math.round(pos)));

/** On release the throw carries it a little further before it picks a slot. */
export const dropSlot = (pos: number, velocity: number, count: number) =>
  slotUnder(pos + Math.max(-12, Math.min(12, velocity)) * 0.09, count);

/**
 * Where a record carried in from the crate would go, from the slot under the
 * hand. Inside the gap already held open it stays; past it, the records
 * beyond stand one slot further on.
 */
export function landingIndex(raw: number, count: number, current?: number): number {
  const at =
    current === undefined || raw < current
      ? Math.round(raw)
      : raw < current + 1
        ? current
        : Math.round(raw - 1);

  return Math.max(0, Math.min(count, at));
}

/** The order with `id` taken out and put back at `to`. */
export function withMoved(ids: string[], id: string, to: number): string[] {
  const rest = ids.filter((other) => other !== id);

  rest.splice(to, 0, id);

  return rest;
}
