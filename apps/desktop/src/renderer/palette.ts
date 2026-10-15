// A sleeve's two strongest colours, for lighting the grooves while it plays.
// Read once per piece of art from a tiny copy of it, and kept for the session.
import { useEffect, useState } from 'react';
import { useArtwork } from './artwork.js';

export type Palette = { a: string; b: string };

const BINS = 24;
// Below this a pixel reads as grey or black, and says nothing about the art's colour.
const MIN_SATURATION = 0.2;
const MIN_VALUE = 0.15;
// Mostly grey art keeps the grooves' own cold light rather than a muddy tint.
const MIN_COLOURED = 0.04;
// The second colour must sit at least this many bins round the wheel from the first, and carry some weight.
const SPREAD = 3;
const SECOND_SHARE = 0.15;
// Every colour is lifted to the same lightness so dark art still lights the grooves.
const LIGHTNESS = 0.66;
const SAMPLE = 24;

/** The two strongest hues in RGBA pixels, or undefined when the art is mostly grey. */
export function pickPalette(pixels: Uint8ClampedArray | Uint8Array): Palette | undefined {
  const weight = new Float64Array(BINS);
  const sums = Array.from({ length: BINS }, () => [0, 0, 0]);
  let count = 0;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3]! < 128) continue;

    count++;

    const [r, g, b] = [pixels[i]! / 255, pixels[i + 1]! / 255, pixels[i + 2]! / 255];
    const max = Math.max(r, g, b);
    const s = max === 0 ? 0 : (max - Math.min(r, g, b)) / max;

    if (s < MIN_SATURATION || max < MIN_VALUE) continue;

    const bin = Math.floor((hue(r, g, b) / 360) * BINS) % BINS;
    const w = s * max;

    weight[bin]! += w;
    sums[bin]![0]! += r * w;
    sums[bin]![1]! += g * w;
    sums[bin]![2]! += b * w;
  }

  const total = weight.reduce((x, y) => x + y, 0);

  if (count === 0 || total / count < MIN_COLOURED) return undefined;

  // A hue split across two neighbouring bins still counts as one colour.
  const around = (i: number) => [i - 1, i, i + 1].map((j) => (j + BINS) % BINS);
  const score = Array.from({ length: BINS }, (_, i) =>
    around(i).reduce((s, j, k) => s + weight[j]! * (k === 1 ? 1 : 0.5), 0),
  );
  const first = score.indexOf(Math.max(...score));
  const far = score.map((s, i) => (wheel(i, first) >= SPREAD ? s : -1));
  const best = Math.max(...far);
  const second = best >= score[first]! * SECOND_SHARE ? far.indexOf(best) : first;

  const colour = (i: number) => {
    const rgb = [0, 0, 0];
    let w = 0;

    for (const j of around(i)) {
      w += weight[j]!;

      for (let c = 0; c < 3; c++) rgb[c]! += sums[j]![c]!;
    }

    return lifted(rgb.map((v) => v / w) as [number, number, number]);
  };

  return { a: colour(first), b: colour(second) };
}

function wheel(i: number, j: number): number {
  const d = Math.abs(i - j);

  return Math.min(d, BINS - d);
}

function hue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);

  if (d === 0) return 0;

  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;

  return h * 60;
}

/** The colour's hue at a fixed lightness, saturation kept between muted and loud. */
function lifted([r, g, b]: [number, number, number]): string {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));

  return `hsl(${Math.round(hue(r, g, b))} ${Math.round(Math.min(0.9, Math.max(0.45, s)) * 100)}% ${LIGHTNESS * 100}%)`;
}

// null: read, and the art is grey or couldn't be read.
const palettes = new Map<string, Palette | null>();

function read(url: string): Promise<Palette | null> {
  return new Promise((resolve) => {
    const image = new Image();

    // The art comes from its own scheme, so the canvas may read it only as a CORS image.
    image.crossOrigin = 'anonymous';

    image.onload = () => {
      const canvas = document.createElement('canvas');

      canvas.width = canvas.height = SAMPLE;

      const g = canvas.getContext('2d', { willReadFrequently: true });

      let palette: Palette | null = null;

      try {
        g!.drawImage(image, 0, 0, SAMPLE, SAMPLE);
        palette = pickPalette(g!.getImageData(0, 0, SAMPLE, SAMPLE).data) ?? null;
      } catch {
        // A canvas the art tainted can't be read; the grooves keep their own light.
      }

      resolve(palette);
    };

    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/** The palette of a track's art once read; undefined while reading, or when it has none worth using. */
export function usePalette(trackId: string | undefined): Palette | undefined {
  const url = useArtwork(trackId);
  const [, setRead] = useState(0);

  useEffect(() => {
    if (!url || palettes.has(url)) return;

    let alive = true;

    void read(url).then((palette) => {
      palettes.set(url, palette);

      if (alive) setRead((n) => n + 1);
    });

    return () => {
      alive = false;
    };
  }, [url]);

  return (url && palettes.get(url)) || undefined;
}
