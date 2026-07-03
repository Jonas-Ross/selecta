// JXA snippets for in-place playlist mutation (issue #15: add/remove tracks).
//
// Both scripts guard before touching anything: unknown playlist ID returns
// { playlistNotFound }, a non-user playlist (smart/subscription/folder/special)
// returns { notEditable }, and unresolvable tracks/positions return
// { missingTrackIds } / { invalidPositions } — the bridge maps each to a
// structured error. On success they return the playlist's FULL post-edit track
// order so the cache patch works from ground truth.
//
// Write strategy (probed against a real Music.app, 2026-07):
//
// APPEND then VERIFY-AND-TRIM. On an iCloud-synced library, duplicate()
// nondeterministically materializes ONE or TWO entries for a single call —
// the double is real (distinct playlist indexes) and persists. So after
// appending, the script settles (~0.5s), counts each added id's occurrences
// against the expected count (pre-read + times requested), and deletes
// surplus trailing occurrences until they match. Only ids this call added
// are ever trimmed.
//
// POSITIONAL INSERT then rotates the displaced originals to the end: Music's
// JXA rejects every insertion-location form (`tracks.beginning`,
// `tracks[i].before` → "Can't get object" / "descriptor type mismatch"); the
// only working move is `Music.move(track, { to: playlist })`, which sends
// the entry to the END. Moving pl.tracks[position] (originalCount − position)
// times slides each displaced original into the same source index.
//
// REMOVAL never showed the doubling; it deletes by index in DESCENDING order
// so positions stay valid while deleting.
//
// Both scripts return the playlist's PRE-edit order alongside the post-edit
// order, read within the same script execution. A freshly created playlist
// is additionally unreliable while its initial sync settles — phantom
// entries drift in, and post-create edits can be wiped back to the created
// state (docs/music-app.md, iCloud sync) — so edits are only exactly assertable
// against a baseline captured atomically with them.

import { wrapJxaScript } from './wrap.js';
import { PLAYLIST_KIND_FN } from './playlist_kind.js';
import { RESOLVE_TRACKS } from './resolve_tracks.js';

// Resolves `pl` or returns the guard sentinel. Music.playlists.whose() spans
// every kind, so a smart playlist with the requested ID is found and then
// rejected as notEditable rather than misreported as missing. Editability
// uses the canonical playlistKind classifier so the bridge guard and the
// cache's `kind` column (written by the same function) agree by construction.
const FIND_EDITABLE_PLAYLIST = `
  ${PLAYLIST_KIND_FN}
  const matches = Music.playlists.whose({ persistentID: args.playlistId })();
  if (matches.length === 0) return JSON.stringify({ playlistNotFound: true });
  const pl = matches[0];
  if (playlistKind(pl) !== 'user') {
    return JSON.stringify({ notEditable: true });
  }
`;

// Bulk persistentID() raises -1728 on an empty collection (docs/music-app.md, JXA).
const EDIT_RESULT = `
  function readTrackIds() {
    return pl.tracks.length > 0 ? pl.tracks.persistentID() : [];
  }
  function editResult(preEditIds, extra) {
    const ids = readTrackIds();
    const out = {
      persistentId: pl.persistentID(),
      trackCount: ids.length,
      trackPersistentIds: ids,
      preEditTrackPersistentIds: preEditIds,
    };
    for (const key in extra || {}) out[key] = extra[key];
    return JSON.stringify(out);
  }
`;

export function buildAddTracksScript(args: {
  playlistId: string;
  trackIds: string[];
  position?: number;
}): string {
  return wrapJxaScript(
    args,
    `
      ${FIND_EDITABLE_PLAYLIST}
      ${EDIT_RESULT}
      ${RESOLVE_TRACKS}
      const preEditIds = readTrackIds();
      const originalCount = preEditIds.length;

      // Expected post-add occurrence count for each added id: occurrences in
      // the pre-read plus the times this call adds it.
      const expected = {};
      for (let i = 0; i < preEditIds.length; i++) {
        if (args.trackIds.indexOf(preEditIds[i]) !== -1) {
          expected[preEditIds[i]] = (expected[preEditIds[i]] || 0) + 1;
        }
      }
      for (let i = 0; i < args.trackIds.length; i++) {
        expected[args.trackIds[i]] = (expected[args.trackIds[i]] || 0) + 1;
      }

      for (let i = 0; i < args.trackIds.length; i++) {
        trackById[args.trackIds[i]].duplicate({ to: pl });
      }

      // Verify-and-trim the nondeterministic double (header comment): index
      // of a surplus trailing occurrence of an added id, or -1 when every
      // added id's count matches the target.
      function surplusIndex(ids) {
        for (const id in expected) {
          let count = 0;
          for (let i = 0; i < ids.length; i++) if (ids[i] === id) count++;
          if (count > expected[id]) {
            for (let i = ids.length - 1; i >= 0; i--) if (ids[i] === id) return i;
          }
        }
        return -1;
      }
      delay(0.5);
      for (let guard = 0; guard < args.trackIds.length + 5; guard++) {
        const doomed = surplusIndex(readTrackIds());
        if (doomed === -1) break;
        Music.delete(pl.tracks[doomed]);
      }

      if (args.position != null && args.position < originalCount) {
        // Rotate the displaced originals to the end. Each move slides the next
        // original into the same source index.
        for (let i = 0; i < originalCount - args.position; i++) {
          Music.move(pl.tracks[args.position], { to: pl });
        }
      }
      return editResult(preEditIds);
    `,
  );
}

export function buildRemoveTracksScript(args: {
  playlistId: string;
  trackIds?: string[];
  positions?: number[];
}): string {
  return wrapJxaScript(
    args,
    `
      ${FIND_EDITABLE_PLAYLIST}
      ${EDIT_RESULT}
      const liveIds = readTrackIds();
      const doomed = {};
      const wantedIds = args.trackIds || [];
      const missing = [];
      for (let i = 0; i < wantedIds.length; i++) {
        let found = false;
        for (let j = 0; j < liveIds.length; j++) {
          if (liveIds[j] === wantedIds[i]) { doomed[j] = true; found = true; }
        }
        if (!found) missing.push(wantedIds[i]);
      }
      if (missing.length > 0) return JSON.stringify({ missingTrackIds: missing });
      const positions = args.positions || [];
      const invalid = [];
      for (let i = 0; i < positions.length; i++) {
        if (positions[i] >= liveIds.length) invalid.push(positions[i]);
        else doomed[positions[i]] = true;
      }
      if (invalid.length > 0) {
        return JSON.stringify({ invalidPositions: invalid, liveTrackCount: liveIds.length });
      }
      const indexes = Object.keys(doomed).map(Number).sort((a, b) => b - a);
      for (let i = 0; i < indexes.length; i++) Music.delete(pl.tracks[indexes[i]]);
      return editResult(liveIds, { removedCount: indexes.length });
    `,
  );
}
