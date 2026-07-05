// JXA snippets for track-signal writes (issue #18: set_loved / set_rating).
//
// Modern Music.app has no 'loved' property — the read/write name is
// 'favorited' (docs/music-app.md, library contents). Rating writes the user
// rating, 0..100 native scale; a track without a USER rating reads back as
// null — the script normalizes both Music.app's 0-means-unrated and
// computed (album-derived) ratings here in the bridge, so the cache and the
// restore baseline only ever carry real user signal.
//
// One skeleton, parameterized by the property read/write. It resolves every
// requested track before writing anything (RESOLVE_TRACKS returns
// { missingTrackIds } untouched on any live miss), then returns pre- and
// post-write values read within the same script execution: the post-write
// read is the cache patch's ground truth, the pre-write read the caller's
// exact restore/assert baseline (the atomic-baseline idea from the playlist
// edit scripts). Each script reads ONLY the property it writes — readbacks
// cost one Apple event per track per property, and the untouched property is
// the refresh path's business.

import { wrapJxaScript } from './wrap.js';
import { RESOLVE_TRACKS } from './resolve_tracks.js';

function buildTrackSignalScript(args: object, opts: { read: string; write: string }): string {
  return wrapJxaScript(
    args,
    `
      ${RESOLVE_TRACKS}
      function states() {
        const out = [];
        for (const id in trackById) {
          const t = trackById[id];
          out.push({ persistentId: id, ${opts.read} });
        }
        return out;
      }
      const preWrite = states();
      for (const id in trackById) ${opts.write};
      return JSON.stringify({ tracks: states(), preWriteTracks: preWrite });
    `,
  );
}

export function buildSetLovedScript(args: { trackIds: string[]; loved: boolean }): string {
  return buildTrackSignalScript(args, {
    read: 'loved: t.favorited() === true',
    write: 'trackById[id].favorited = args.loved',
  });
}

export function buildSetRatingScript(args: { trackIds: string[]; rating: number }): string {
  return buildTrackSignalScript(args, {
    // Only a USER rating is signal: with the user rating cleared, rating()
    // reports a computed (album-derived) value on some tracks — recording
    // that in preWriteTracks would make a later restore write it back as an
    // explicit user rating the user never set. ratingKind distinguishes them.
    read: "rating: t.ratingKind() === 'user' ? (t.rating() || null) : null",
    write: 'trackById[id].rating = args.rating',
  });
}
