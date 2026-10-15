// What the empty rail shows while the agent builds: white labels standing in the
// slots records will fill, and the agent's latest step in plain words.
import { PAD } from './lanes.js';

// Tool names as the log holds them, underscores already spaces.
const STEPS: Record<string, string> = {
  'library overview': 'reading your library',
  search: 'searching your crates',
  'get track context': 'looking closer at a record',
  'list playlists': 'reading your playlists',
  'inspect tracklist': 'checking the order',
  'show playlist draft': 'laying records out',
  'get playlist draft': 'reading the draft',
  'edit playlist draft': 'laying records out',
};

/** The latest tool call in plain words, or where every run starts. */
export const digStep = (tool?: string) =>
  tool === undefined ? 'reading your brief' : (STEPS[tool] ?? tool);

/** Whole slots that fit the visible rail, never fewer than one or more than a crate's worth. */
export const ghostCount = (view: number, step: number, gap: number) =>
  Math.min(10, Math.max(1, Math.floor((view - PAD + gap / 2) / step)));

/** The next sleeve to pull: never the one just pulled, and not simply the neighbour. */
export function nextPull(current: number, turn: number, count: number): number {
  if (count < 2) return 0;

  return (current + 1 + (turn % Math.max(1, count - 1))) % count;
}
