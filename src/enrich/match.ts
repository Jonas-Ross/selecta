// Matching heuristics for mapping a library track onto external catalog
// records. Pure functions — the fetch adapters in sources.ts apply them.
// Tuned on a live 30-track probe of a real library (issue #19): strip
// feat-clauses, query only the primary artist, gate on duration so a
// remix/extended edit can't stand in for the album cut.

/** Drop "(feat. X)" / "[with X]" qualifiers and trailing "feat. X" clauses. */
export function stripFeat(s: string): string {
  return s
    .replace(/\s*[[(](feat|ft|featuring|with)\.?\s[^\])]*[\])]/gi, '')
    .replace(/\s+(feat|ft|featuring)\.?\s.*$/i, '')
    .trim();
}

/** First credited artist: "Tiësto, Odd Mob & Goodboys" → "Tiësto". */
export function primaryArtist(artist: string): string {
  return stripFeat(artist)
    .split(/\s*(?:,|&|\s+x\s+|\s+vs\.?\s+)\s*/i)[0]!
    .trim();
}

/**
 * ±10s window. An unknown length on either side passes — the score and
 * text gates still stand, and rejecting every length-less candidate would
 * cost more real matches than it prevents mismatches.
 */
export function durationCompatible(
  aSeconds: number | null | undefined,
  bSeconds: number | null | undefined,
): boolean {
  if (aSeconds == null || bSeconds == null) return true;
  return Math.abs(aSeconds - bSeconds) <= 10;
}

/** Escape Lucene operators so a title/artist can't break the MusicBrainz query. */
export function luceneEscape(s: string): string {
  return s.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1');
}
