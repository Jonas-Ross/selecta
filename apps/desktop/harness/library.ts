import { crc32, deflateSync } from 'node:zlib';
import type { SimTrack } from './music.js';

const ARTISTS = ['Low Orbit', 'Nightjar', 'Pale Signal', 'Tessellate', 'Umber Club', 'Kasm'];
const WORDS = [
  'Glue',
  'Swept',
  'Opal',
  'Atlas',
  'Ember',
  'Lumen',
  'Drift',
  'Halo',
  'Tide',
  'Vessel',
];
const KEYS = [
  'A minor',
  'E minor',
  'B minor',
  'F# minor',
  'C major',
  'G major',
  'D minor',
  'F major',
];

export type FixtureTrack = SimTrack & { bpm?: number; musicalKey?: string };

export function fixtureTracks(count = 40): FixtureTrack[] {
  return Array.from({ length: count }, (_, i) => ({
    persistentId: (0x1000000000000000n + BigInt(i) * 0x1111n).toString(16).toUpperCase(),
    name: `${WORDS[i % WORDS.length]} ${WORDS[(i * 3 + 1) % WORDS.length]}`,
    artist: ARTISTS[i % ARTISTS.length],
    album: `${WORDS[(i + 4) % WORDS.length]} EP`,
    genre: 'Electronic',
    year: 2016 + (i % 9),
    duration: 300 + ((i * 37) % 180),
    dateAdded: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    playedCount: i % 7,
    artwork: sleeve((i * 47) % 360),
    // Some unmeasured, so the lanes' "not measured" spans get drawn.
    ...(i % 5 !== 4 && { bpm: 118 + ((i * 3) % 12), musicalKey: KEYS[i % KEYS.length] }),
  }));
}

export function sleeve(hue: number, size = 64): Uint8Array {
  const rows = Buffer.alloc(size * (size * 3 + 1));

  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const [r, g, b] = hsl(hue + ((x + y) / size) * 40, 0.55, 0.25 + (y / size) * 0.35);

      rows.set([r, g, b], y * (size * 3 + 1) + 1 + x * 3);
    }

  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);

    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);

    return out;
  };
  const header = Buffer.alloc(13);

  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;

    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };

  return [f(0), f(8), f(4)];
}
