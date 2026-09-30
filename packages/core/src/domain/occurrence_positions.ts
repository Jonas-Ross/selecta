/** Index every occurrence without collapsing repeated IDs or position gaps. */
export function occurrencePositions(ids: readonly string[]): Map<string, number[]> {
  const positions = new Map<string, number[]>();

  ids.forEach((id, position) => {
    const existing = positions.get(id);

    if (existing) existing.push(position);
    else positions.set(id, [position]);
  });

  return positions;
}
