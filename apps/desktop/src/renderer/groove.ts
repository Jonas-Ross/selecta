// The background's geometry: the draft cut as one side of a record, a band of
// grooves per record as wide as it is long, read from the outside in.

export type Band = { id: string; outer: number; inner: number };
export type Ring = { r: number; loud: number };
export type Cut = { cx: number; cy: number; bands: Band[]; rings: Ring[] };

// The centre sits far below the window so the arcs run nearly level with the rail.
const CENTRE = { x: 0.42, y: 2.05 };
// The smooth run between two tracks, as on a pressed LP.
const GAP = 16;
// A record with no known length cuts as long as the average one, or this with none known.
const FALLBACK_SECONDS = 300;

/** The cut for a width × height window; no records cuts one band across the whole side. */
export function cut(
  width: number,
  height: number,
  records: { id: string; seconds?: number }[],
): Cut {
  const cx = width * CENTRE.x;
  const cy = height * CENTRE.y;
  const outer = Math.hypot(Math.max(cx, width - cx), cy) + 4;
  const inner = cy - height - 60;
  const side = records.length ? records : [{ id: 'side' }];
  const known = side.flatMap((r) => (r.seconds && r.seconds > 0 ? [r.seconds] : []));
  const fallback = known.length ? known.reduce((a, b) => a + b) / known.length : FALLBACK_SECONDS;
  const seconds = side.map((r) => (r.seconds && r.seconds > 0 ? r.seconds : fallback));
  const total = seconds.reduce((a, b) => a + b);
  const span = Math.max(0, outer - inner - GAP * (side.length - 1));
  const bands: Band[] = [];
  const rings: Ring[] = [];
  let at = outer;

  side.forEach((record, i) => {
    const band = { id: record.id, outer: at, inner: at - (seconds[i]! / total) * span };

    bands.push(band);
    rings.push(...grooves(band));
    at = band.inner - GAP;
  });

  return { cx, cy, bands, rings };
}

/** One band's grooves. Loud passages press wider, brighter grooves; seeded by the record, so it keeps its cut when moved. */
function grooves(band: Band): Ring[] {
  const seed = [...band.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const a = 0.08 + (seed % 7) * 0.01;
  const b = 0.03 + ((seed >>> 3) % 5) * 0.004;
  const phase = (seed % 628) / 100;
  const out: Ring[] = [];

  for (let r = band.outer, k = 0; r > band.inner; k++) {
    const loud = 0.5 + 0.5 * Math.sin(k * a + phase) * Math.sin(k * b + phase / 2);

    out.push({ r, loud });
    r -= 2.4 + loud * 1.6;
  }

  return out;
}
