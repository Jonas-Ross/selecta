// JXA snippets for track-signal writes (issue #18: set_loved / set_rating).
//
// Modern Music.app has no 'loved' property — the read/write name is
// 'favorited' (docs/music-app.md, library contents). Rating writes the user
// rating, 0..100 native scale, 0 = unrated.
//
// Both scripts resolve every requested track before writing anything —
// RESOLVE_TRACKS returns { missingTrackIds } untouched on any live miss — and
// return pre- and post-write values read within the same script execution:
// the post-write read is the cache patch's ground truth, the pre-write read
// the caller's exact restore/assert baseline (same atomic-baseline idea as
// the playlist edit scripts).

import { wrapJxaScript } from './wrap.js';
import { RESOLVE_TRACKS } from './resolve_tracks.js';

// Reads { persistentId, loved, rating } for each unique resolved track, in
// first-seen order (trackById preserves insertion order).
const READ_SIGNAL_STATES = `
  function signalStates() {
    const states = [];
    for (const id in trackById) {
      const t = trackById[id];
      states.push({ persistentId: id, loved: t.favorited() === true, rating: t.rating() || 0 });
    }
    return states;
  }
`;

export function buildSetLovedScript(args: { trackIds: string[]; loved: boolean }): string {
  return wrapJxaScript(
    args,
    `
      ${RESOLVE_TRACKS}
      ${READ_SIGNAL_STATES}
      const preWrite = signalStates();
      for (const id in trackById) trackById[id].favorited = args.loved;
      return JSON.stringify({ tracks: signalStates(), preWriteTracks: preWrite });
    `,
  );
}

export function buildSetRatingScript(args: { trackIds: string[]; rating: number }): string {
  return wrapJxaScript(
    args,
    `
      ${RESOLVE_TRACKS}
      ${READ_SIGNAL_STATES}
      const preWrite = signalStates();
      for (const id in trackById) trackById[id].rating = args.rating;
      return JSON.stringify({ tracks: signalStates(), preWriteTracks: preWrite });
    `,
  );
}
