// JXA snippet: read the full library (all tracks + non-special playlists) as a
// LibrarySnapshot. Tracks use bulk property getters — one Apple event per
// property instead of one per track — which turns a 10k-track read from minutes
// into seconds. Probed property names: 'favorited' (not the removed 'loved'),
// 'playedDate', 'playedCount', 'skippedCount', 'comment'.
//
// location_kind comes from the track class: fileTrack has a local file, every
// other class (sharedTrack, URLTrack) is cloud. The 'location' property is NOT
// usable here — it raises on cloud tracks, poisoning the bulk read.

import { wrapJxaScript } from './wrap.js';
import { PLAYLIST_KIND_FN } from './playlist_kind.js';

// Test-support: just the library's track persistent IDs — one bulk Apple
// event instead of the full ~19-property snapshot read.
export function buildListLibraryTrackIdsScript(): string {
  return wrapJxaScript(
    {},
    `
      const lib = Music.libraryPlaylists[0];
      return JSON.stringify(lib.tracks.length > 0 ? lib.tracks.persistentID() : []);
    `,
  );
}

export function buildReadLibraryScript(): string {
  return wrapJxaScript(
    {},
    `
      ${PLAYLIST_KIND_FN}

      const lib = Music.libraryPlaylists[0];
      const n = lib.tracks.length;

      // One Apple event per property. A property that fails to bulk-read (e.g.
      // missing from this macOS version's dictionary) degrades to absent-for-all
      // rather than failing the snapshot.
      function bulk(prop) {
        if (n === 0) return [];
        try { return lib.tracks[prop](); } catch (e) { return null; }
      }

      const ids = bulk('persistentID');
      if (ids === null) throw new Error('Could not bulk-read track persistent IDs');
      const cols = {
        title: bulk('name'), artist: bulk('artist'), albumArtist: bulk('albumArtist'),
        album: bulk('album'), genre: bulk('genre'), year: bulk('year'),
        durationSeconds: bulk('duration'), bpm: bulk('bpm'),
        trackNumber: bulk('trackNumber'), discNumber: bulk('discNumber'),
        dateAdded: bulk('dateAdded'), lastPlayed: bulk('playedDate'),
        playCount: bulk('playedCount'), skipCount: bulk('skippedCount'),
        rating: bulk('rating'), loved: bulk('favorited'), disliked: bulk('disliked'),
        comments: bulk('comment'), cls: bulk('class'),
      };

      const col = (name, i) => (cols[name] === null ? null : cols[name][i]);
      const tracks = [];
      for (let i = 0; i < n; i++) {
        const t = { persistentId: ids[i] };
        // Strings: empty string means unset in Music.app.
        for (const k of ['title', 'artist', 'albumArtist', 'album', 'genre', 'comments']) {
          const v = col(k, i);
          if (v) t[k] = v;
        }
        // Numerics where 0 means unset.
        for (const k of ['year', 'bpm', 'trackNumber', 'discNumber', 'rating']) {
          const v = col(k, i);
          if (v) t[k] = v;
        }
        const dur = col('durationSeconds', i);
        if (dur) t.durationSeconds = dur;
        // Counts where 0 is meaningful.
        const plays = col('playCount', i);
        if (plays !== null && plays !== undefined) t.playCount = plays;
        const skips = col('skipCount', i);
        if (skips !== null && skips !== undefined) t.skipCount = skips;
        // Dates serialize to ISO 8601 via JSON.stringify.
        const added = col('dateAdded', i);
        if (added) t.dateAdded = added;
        const played = col('lastPlayed', i);
        if (played) t.lastPlayed = played;
        // Booleans: emit only when true; the cache defaults to 0.
        if (col('loved', i) === true) t.loved = true;
        if (col('disliked', i) === true) t.disliked = true;
        const cls = col('cls', i);
        if (cls) t.locationKind = String(cls) === 'fileTrack' ? 'local' : 'cloud';
        tracks.push(t);
      }

      // Playlists are few (~100); per-playlist property reads are fine. Special
      // playlists (Library, Music, …) are skipped: caching the entire library as
      // a playlist would poison playlist co-occurrence and waste rows.
      const playlists = [];
      const pls = Music.playlists;
      const plCount = pls.length;
      for (let i = 0; i < plCount; i++) {
        const pl = pls[i];
        const kind = playlistKind(pl);
        if (kind === 'special') continue;
        let trackPersistentIds = [];
        // Bulk getter raises errAENoSuchObject (-1728) on empty collections —
        // short-circuit empty (and folders, which have no own tracks) to [].
        if (kind !== 'folder' && pl.tracks.length > 0) {
          trackPersistentIds = pl.tracks.persistentID();
        }
        const p = {
          persistentId: pl.persistentID(),
          name: pl.name(),
          kind: kind,
          trackPersistentIds: trackPersistentIds,
        };
        try {
          const parent = pl.parent();
          if (parent) p.parentPersistentId = parent.persistentID();
        } catch (e) {}
        playlists.push(p);
      }

      return JSON.stringify({
        capturedAt: new Date().toISOString(),
        tracks: tracks,
        playlists: playlists,
      });
    `,
  );
}
