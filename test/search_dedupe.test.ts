// Canonical-track dedup on search (issue #16): cache layer + tool layer.
// Own fixture snapshot — the shared library.json is asserted by exact counts
// elsewhere, and dedupe needs a library dense with true dupes and version
// variants.

import { describe, it, expect } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import { handleSearch, type SearchOutput } from '../src/tools/search.js';
import type { ToolDeps } from '../src/tools/common.js';
import type { LibrarySnapshot, RawTrack } from '../src/types/bridge.js';
import { makeBridge } from './helpers.js';

function track(persistentId: string, fields: Partial<RawTrack> = {}): RawTrack {
  return { persistentId, ...fields };
}

// The duplicate landscape from the issue: Levels across three albums (one a
// Various Artists compilation), a loved later copy of Dark Paradise, version
// variants that must survive, case-variant duplicates, and identity-less rows.
const snapshot: LibrarySnapshot = {
  capturedAt: '2026-06-01T12:00:00.000Z',
  tracks: [
    // "Levels": studio album (2013) vs artist best-of (2023) vs VA compilation
    // (2011, earliest year but compilation). Winner: LEVELS-TRUE.
    track('T-LEVELS-TRUE', {
      title: 'Levels',
      artist: 'Avicii',
      albumArtist: 'Avicii',
      album: 'True',
      year: 2013,
      playCount: 10,
    }),
    track('T-LEVELS-FOREVER', {
      title: 'Levels',
      artist: 'Avicii',
      albumArtist: 'Avicii',
      album: 'Avicii Forever',
      year: 2023,
      playCount: 90,
    }),
    track('T-LEVELS-NOW', {
      title: 'Levels',
      artist: 'Avicii',
      albumArtist: 'Various Artists',
      album: 'NOW Dance Hits',
      year: 2011,
      playCount: 3,
    }),
    // A version variant: different title, must never collapse into "Levels".
    track('T-LEVELS-RADIO', {
      title: 'Levels (Radio Edit)',
      artist: 'Avicii',
      albumArtist: 'Avicii',
      album: 'Levels (Single)',
      year: 2011,
      playCount: 55,
    }),
    // "Dark Paradise": the LATER copy is loved — loved beats earliest year.
    track('T-DARK-BTD', {
      title: 'Dark Paradise',
      artist: 'Lana Del Rey',
      albumArtist: 'Lana Del Rey',
      album: 'Born to Die',
      year: 2012,
      playCount: 20,
    }),
    track('T-DARK-PARADISE-ED', {
      title: 'Dark Paradise',
      artist: 'Lana Del Rey',
      albumArtist: 'Lana Del Rey',
      album: 'Born to Die — Paradise Edition',
      year: 2013,
      loved: true,
      playCount: 5,
    }),
    // Case/whitespace variants of the same song collapse.
    track('T-SUMMER-A', {
      title: 'Summertime Sadness',
      artist: 'Lana Del Rey',
      albumArtist: 'Lana Del Rey',
      album: 'Born to Die',
      year: 2012,
      playCount: 40,
    }),
    track('T-SUMMER-B', {
      title: '  summertime sadness ',
      artist: 'LANA DEL REY',
      albumArtist: 'Various Artists',
      album: 'Pop Anthems',
      year: 2014,
      playCount: 2,
    }),
    // A live version variant next to its studio original.
    track('T-ONEMORE', {
      title: 'One More Time',
      artist: 'Daft Punk',
      album: 'Discovery',
      year: 2001,
      playCount: 33,
    }),
    track('T-ONEMORE-LIVE', {
      title: 'One More Time (Live)',
      artist: 'Daft Punk',
      album: 'Alive 2007',
      year: 2007,
      playCount: 8,
    }),
    // No artist / no title: identity can't be established — never collapsed,
    // even against an identical-looking neighbor.
    track('T-NOARTIST-A', { title: 'Untitled Demo', year: 2020 }),
    track('T-NOARTIST-B', { title: 'Untitled Demo', year: 2021 }),
    track('T-BARE'),
  ],
  playlists: [
    {
      persistentId: 'P-EDM',
      name: 'EDM',
      kind: 'user',
      trackPersistentIds: ['T-LEVELS-FOREVER', 'T-LEVELS-TRUE', 'T-ONEMORE'],
    },
  ],
};

function freshCache(): SelectaCache {
  const cache = SelectaCache.open(':memory:');
  cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
  return cache;
}

function ids(rows: { persistentId: string }[]): string[] {
  return rows.map((r) => r.persistentId);
}

describe('cache searchTracks dedupe', () => {
  it('is off by default: every copy is a row', () => {
    const { rows, total } = freshCache().searchTracks({ artist: 'Avicii' });
    expect(total).toBe(4);
    expect(ids(rows)).toHaveLength(4);
  });

  it('collapses same-song copies to one winner and reports total as group count', () => {
    const { rows, total } = freshCache().searchTracks({ artist: 'Avicii', dedupe: true });
    // "Levels" collapses to one; "Levels (Radio Edit)" is a distinct version.
    expect(total).toBe(2);
    expect(ids(rows)).toContain('T-LEVELS-TRUE');
    expect(ids(rows)).toContain('T-LEVELS-RADIO');
  });

  it('winner tiebreak: studio album beats Various Artists compilation, then earliest year', () => {
    const { rows } = freshCache().searchTracks({ query: 'levels', dedupe: true });
    const levels = rows.find((r) => r.persistentId.startsWith('T-LEVELS') && r.title === 'Levels');
    // Not T-LEVELS-NOW (VA compilation, despite earliest year), not
    // T-LEVELS-FOREVER (2023 > 2013).
    expect(levels?.persistentId).toBe('T-LEVELS-TRUE');
  });

  it('winner tiebreak: loved beats an earlier release', () => {
    const { rows } = freshCache().searchTracks({ query: 'dark paradise', dedupe: true });
    expect(ids(rows)).toEqual(['T-DARK-PARADISE-ED']);
  });

  it('reports suppressed copies as sorted alternateIds on the winner only', () => {
    const { rows } = freshCache().searchTracks({ artist: 'Avicii', dedupe: true });
    const winner = rows.find((r) => r.persistentId === 'T-LEVELS-TRUE');
    expect(winner?.alternateIds).toEqual(['T-LEVELS-FOREVER', 'T-LEVELS-NOW']);
    const radio = rows.find((r) => r.persistentId === 'T-LEVELS-RADIO');
    expect(radio?.alternateIds).toBeUndefined();
  });

  it('collapses case- and whitespace-variant titles/artists', () => {
    const { rows, total } = freshCache().searchTracks({ query: 'summertime', dedupe: true });
    expect(total).toBe(1);
    expect(ids(rows)).toEqual(['T-SUMMER-A']);
    expect(rows[0]?.alternateIds).toEqual(['T-SUMMER-B']);
  });

  it('keeps version variants: live/radio-edit titles are different songs', () => {
    const { rows, total } = freshCache().searchTracks({ query: 'one more time', dedupe: true });
    expect(total).toBe(2);
    expect(ids(rows).sort()).toEqual(['T-ONEMORE', 'T-ONEMORE-LIVE']);
  });

  it('never collapses rows missing a title or artist', () => {
    const { total } = freshCache().searchTracks({ dedupe: true });
    // 13 tracks − 2 Levels dupes − 1 Dark Paradise dupe − 1 Summertime dupe;
    // the two artist-less "Untitled Demo" rows and T-BARE all survive.
    expect(total).toBe(9);
  });

  it('applies sort lenses to the representatives', () => {
    const { rows } = freshCache().searchTracks({
      artist: 'Avicii',
      dedupe: true,
      sort: 'least_played',
    });
    // Winners are T-LEVELS-TRUE (10 plays) and T-LEVELS-RADIO (55 plays) —
    // ordered by THEIR play counts, not the suppressed copies'.
    expect(ids(rows)).toEqual(['T-LEVELS-TRUE', 'T-LEVELS-RADIO']);
  });

  it('composes with playlist_order over the deduped representatives', () => {
    const { rows } = freshCache().searchTracks({
      inPlaylist: 'P-EDM',
      dedupe: true,
      sort: 'playlist_order',
    });
    // The playlist holds two Levels copies; the group winner (T-LEVELS-TRUE)
    // represents them, sorted at ITS first occurrence (position 1).
    expect(ids(rows)).toEqual(['T-LEVELS-TRUE', 'T-ONEMORE']);
  });

  it('respects the limit after collapsing, not before', () => {
    const { rows, total } = freshCache().searchTracks({ artist: 'Avicii', dedupe: true, limit: 1 });
    expect(total).toBe(2);
    expect(rows).toHaveLength(1);
  });
});

describe('search tool dedupe', () => {
  function makeDeps(): ToolDeps {
    const cache = freshCache();
    return { cache: () => cache, bridge: makeBridge() };
  }

  it('passes the flag through and surfaces alternate_ids on the wire', async () => {
    const out = (await handleSearch(
      { artist: 'Avicii', dedupe: true },
      makeDeps(),
    )) as SearchOutput;
    expect(out.total_matches).toBe(2);
    const winner = out.tracks.find((t) => t.persistent_id === 'T-LEVELS-TRUE');
    expect(winner?.alternate_ids).toEqual(['T-LEVELS-FOREVER', 'T-LEVELS-NOW']);
    const radio = out.tracks.find((t) => t.persistent_id === 'T-LEVELS-RADIO');
    expect(radio).toBeDefined();
    expect(radio?.alternate_ids).toBeUndefined();
  });

  it('omits alternate_ids entirely when dedupe is off', async () => {
    const out = (await handleSearch({ artist: 'Avicii' }, makeDeps())) as SearchOutput;
    expect(out.tracks).toHaveLength(4);
    for (const t of out.tracks) expect(t.alternate_ids).toBeUndefined();
  });
});
