// Shared JXA snippet: resolve args.trackIds to live track objects. Tracks are
// resolved with whose({persistentID}) — one filtered Apple event per unique
// ID. Slower than an index map, but positional indexing (lib.tracks[i]) does
// NOT follow the bulk persistentID() read order (observed diverging on a real
// library, silently adding the wrong track), so whose() is the only correct
// resolver.
//
// If any requested ID is missing from the live library the snippet returns
// { missingTrackIds } BEFORE the caller touches anything; the bridge maps
// that to track_not_found ("cache is stale").

export const RESOLVE_TRACKS = `
  const lib = Music.libraryPlaylists[0];
  const trackById = {};
  const missing = [];
  for (let i = 0; i < args.trackIds.length; i++) {
    const id = args.trackIds[i];
    if (id in trackById) continue;
    const matches = lib.tracks.whose({ persistentID: id })();
    if (matches.length === 0) missing.push(id);
    else trackById[id] = matches[0];
  }
  if (missing.length > 0) {
    return JSON.stringify({ missingTrackIds: missing });
  }
`;
