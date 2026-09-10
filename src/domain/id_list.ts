/** Bound an ID list in error hints while retaining the exact overflow count. */
export function summarizeIds(ids: string[]): string {
  const more = ids.length > 5 ? ` (+${ids.length - 5} more)` : '';

  return `${ids.slice(0, 5).join(', ')}${more}`;
}
