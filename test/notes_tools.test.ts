// Model-persisted notes (issue #32) at the tool layer: set_note validation and
// upsert/clear, the create_playlist note, and verbatim surfacing on every read
// tool in full and compact shape. Bridge mocked, cache real.

import { describe, it, expect, vi } from 'vitest';
import { handleSetNote } from '../src/tools/set_note.js';
import { handleCreatePlaylist, type CreatePlaylistOutput } from '../src/tools/create_playlist.js';
import {
  handlePreviewPlaylist,
  type PreviewPlaylistOutput,
} from '../src/tools/preview_playlist.js';
import { handleDeletePlaylist } from '../src/tools/delete_playlist.js';
import { handleRefreshLibrary } from '../src/tools/refresh_library.js';
import { handleSearch, type CompactSearchOutput, type SearchOutput } from '../src/tools/search.js';
import {
  handleGetTrackContext,
  type CompactTrackContextOutput,
  type MultiSeedContextOutput,
  type TrackContextOutput,
} from '../src/tools/get_track_context.js';
import { handleListPlaylists, type ListPlaylistsOutput } from '../src/tools/list_playlists.js';
import {
  handleInspectTracklist,
  type InspectTracklistOutput,
} from '../src/tools/inspect_tracklist.js';
import {
  COMPACT_TRACK_FIELDS,
  NOTE_MAX_LENGTH,
  type ApiNote,
  type ToolDeps,
} from '../src/tools/common.js';
import type { LibrarySnapshot } from '../src/types/bridge.js';
import { ISO_TIMESTAMP, asError, makeToolDeps } from './helpers.js';
import fixture from './fixtures/library.json' with { type: 'json' };

const snapshot = fixture as LibrarySnapshot;
const makeDeps = makeToolDeps;

/** A successful non-clearing set_note call; returns the stored wire note. */
async function setNote(
  deps: ToolDeps,
  subject: 'track' | 'playlist',
  id: string,
  body: string,
): Promise<ApiNote & { id: string }> {
  const out = await handleSetNote({ subject, id, body }, deps);
  expect(out).toMatchObject({ subject, note: expect.any(Object) });
  const stored = out as { id: string; note: ApiNote };
  return { ...stored.note, id: stored.id };
}

const noteShape = (body: string) => ({
  body,
  created_at: expect.stringMatching(ISO_TIMESTAMP),
  updated_at: expect.stringMatching(ISO_TIMESTAMP),
});

describe('set_note', () => {
  it('stores a track note and returns it with provenance', async () => {
    const deps = makeDeps();
    const out = await handleSetNote(
      { subject: 'track', id: 'T-TEARDROP', body: 'great opener' },
      deps,
    );
    expect(out).toEqual({ subject: 'track', id: 'T-TEARDROP', note: noteShape('great opener') });
    expect(deps.cacheInstance.getNote('track', 'T-TEARDROP')!.body).toBe('great opener');
    // Cache-only: no Apple event fires.
    for (const fn of Object.values(deps.bridge)) expect(fn).not.toHaveBeenCalled();
  });

  it('replaces the previous note wholesale and keeps created_at', async () => {
    const deps = makeDeps();
    const first = await setNote(deps, 'playlist', 'P-LATENIGHT', 'dinner set');
    const second = await setNote(deps, 'playlist', 'P-LATENIGHT', 'dinner set — skip track 2');
    expect(second.body).toBe('dinner set — skip track 2');
    expect(second.created_at).toBe(first.created_at);
  });

  it('stores the body byte-for-byte and clears on empty or whitespace-only', async () => {
    const deps = makeDeps();
    const formatted =
      '  opener candidates:\n    - too abrasive for dinner sets\n  keep for late sets  \n';
    const stored = await setNote(deps, 'track', 'T-ANGEL', formatted);
    expect(stored.body).toBe(formatted);
    expect(deps.cacheInstance.getNote('track', 'T-ANGEL')!.body).toBe(formatted);
    const found = (await handleSearch({ query: 'angel' }, deps)) as SearchOutput;
    expect(found.tracks[0]!.note!.body).toBe(formatted);

    const clear = (body: string) => handleSetNote({ subject: 'track', id: 'T-ANGEL', body }, deps);
    expect(await clear('   ')).toEqual({ subject: 'track', id: 'T-ANGEL', cleared: true });
    expect(deps.cacheInstance.getNote('track', 'T-ANGEL')).toBeNull();
    // Clearing what isn't there is a no-op, not an error.
    expect(await clear('')).toEqual({ subject: 'track', id: 'T-ANGEL', cleared: true });
  });

  it('keys playlist notes by the canonical ID after a rekey', async () => {
    const deps = makeDeps();
    deps.cacheInstance.upsertPlaylistAfterWrite(
      { persistentId: 'P-REKEYED', trackCount: 1 },
      'Rearview',
      ['T-TEARDROP'],
    );
    deps.cacheInstance.recordPlaylistCreation('P-CREATED', 'Rearview', ['T-TEARDROP']);
    deps.cacheInstance.applyRekey('P-CREATED', 'P-CREATED', 'P-REKEYED');

    const out = await setNote(deps, 'playlist', 'P-CREATED', 'arc approved');
    expect(out.id).toBe('P-REKEYED');
    expect(deps.cacheInstance.getNote('playlist', 'P-REKEYED')!.body).toBe('arc approved');
    expect(deps.cacheInstance.getNote('playlist', 'P-CREATED')).toBeNull();
  });

  it('rejects unknown subjects with structured errors, storing nothing', async () => {
    const deps = makeDeps();
    expect(
      asError(await handleSetNote({ subject: 'track', id: 'T-NOPE', body: 'x' }, deps)).error,
    ).toBe('track_not_found');
    expect(
      asError(await handleSetNote({ subject: 'playlist', id: 'P-NOPE', body: 'x' }, deps)).error,
    ).toBe('playlist_not_found');
    expect(deps.cacheInstance.db.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({
      n: 0,
    });
  });

  it('rejects bad shapes and oversized bodies at the boundary', async () => {
    const deps = makeDeps();
    const tooLong = 'x'.repeat(NOTE_MAX_LENGTH + 1);
    for (const raw of [
      { subject: 'album', id: 'T-TEARDROP', body: 'x' },
      { subject: 'track', id: '', body: 'x' },
      { subject: 'track', id: 'T-TEARDROP' },
      { subject: 'track', id: 'T-TEARDROP', body: tooLong },
      { subject: 'track', id: 'T-TEARDROP', body: 'x', extra: true },
    ]) {
      expect(asError(await handleSetNote(raw, deps)).error).toBe('validation_error');
    }
    expect(deps.cacheInstance.getNote('track', 'T-TEARDROP')).toBeNull();
  });
});

describe('create_playlist note', () => {
  function createDeps() {
    return makeDeps({
      createPlaylist: vi.fn().mockImplementation(async (input: { trackIds: string[] }) => ({
        persistentId: 'P-NEW',
        trackCount: input.trackIds.length,
      })),
      clonePlaylist: vi.fn().mockResolvedValue({
        persistentId: 'P-CLONE',
        trackCount: 3,
        sourcePersistentId: 'P-LATENIGHT',
        sourceName: 'Late Night',
        sourceTrackPersistentIds: ['T-TEARDROP', 'T-GLORYBOX', 'T-ROADS'],
      }),
    });
  }

  it('stores the note on the new playlist and echoes it back', async () => {
    const deps = createDeps();
    const out = (await handleCreatePlaylist(
      {
        name: 'The Long Way Home',
        track_ids: ['T-TEARDROP', 'T-ROADS'],
        note: 'User liked the arc; preferred this plain name over the poetic working title.',
      },
      deps,
    )) as CreatePlaylistOutput;

    expect(out.playlist_id).toBe('P-NEW');
    expect(out.note).toEqual(
      noteShape('User liked the arc; preferred this plain name over the poetic working title.'),
    );
    // The note is not a Music.app description — the bridge never sees it.
    expect(deps.bridge.createPlaylist).toHaveBeenCalledWith({
      name: 'The Long Way Home',
      trackIds: ['T-TEARDROP', 'T-ROADS'],
      description: undefined,
    });
    const listed = (await handleListPlaylists(
      { name_query: 'Long Way' },
      deps,
    )) as ListPlaylistsOutput;
    expect(listed.playlists[0]!.note).toEqual(out.note);
  });

  it('stores the note on a cloned playlist too', async () => {
    const deps = createDeps();
    const out = (await handleCreatePlaylist(
      { name: 'Approved', source_playlist_id: 'P-LATENIGHT', note: 'approved from preview' },
      deps,
    )) as CreatePlaylistOutput;
    expect(out.note!.body).toBe('approved from preview');
    expect(deps.cacheInstance.getNote('playlist', 'P-CLONE')!.body).toBe('approved from preview');
  });

  it('stores the creation note verbatim, whitespace included', async () => {
    const deps = createDeps();
    const formatted = ' arc:\n  1. slow open\n  2. peak at 12\n';
    const out = (await handleCreatePlaylist(
      { name: 'Verbatim', track_ids: ['T-TEARDROP'], note: formatted },
      deps,
    )) as CreatePlaylistOutput;
    expect(out.note!.body).toBe(formatted);
    expect(deps.cacheInstance.getNote('playlist', 'P-NEW')!.body).toBe(formatted);
  });

  it('omits note when none was given', async () => {
    const deps = createDeps();
    const out = (await handleCreatePlaylist(
      { name: 'Plain', track_ids: ['T-TEARDROP'] },
      deps,
    )) as CreatePlaylistOutput;
    expect(out.note).toBeUndefined();
  });

  it('rejects a blank note before any bridge call', async () => {
    const deps = createDeps();
    const out = await handleCreatePlaylist(
      { name: 'Plain', track_ids: ['T-TEARDROP'], note: '   ' },
      deps,
    );
    expect(asError(out).error).toBe('validation_error');
    expect(deps.bridge.createPlaylist).not.toHaveBeenCalled();
  });

  it('follows the playlist through refresh-time rekey reconciliation', async () => {
    const deps = createDeps();
    await handleCreatePlaylist(
      { name: 'Rearview', track_ids: ['T-TEARDROP', 'T-ROADS'], note: 'arc approved' },
      deps,
    );
    const rekeyed: LibrarySnapshot = {
      ...snapshot,
      playlists: [
        ...snapshot.playlists,
        {
          persistentId: 'P-REKEYED',
          name: 'Rearview',
          kind: 'user',
          trackPersistentIds: ['T-TEARDROP', 'T-ROADS'],
        },
      ],
    };
    (deps.bridge.readLibrary as ReturnType<typeof vi.fn>).mockResolvedValue(rekeyed);

    await handleRefreshLibrary({}, deps);

    const listed = (await handleListPlaylists(
      { name_query: 'Rearview' },
      deps,
    )) as ListPlaylistsOutput;
    expect(listed.playlists).toHaveLength(1);
    expect(listed.playlists[0]!.id).toBe('P-REKEYED');
    expect(listed.playlists[0]!.note!.body).toBe('arc approved');
  });
});

describe('note surfacing', () => {
  const TRACK_NOTE = 'use this version, not the remaster';
  const PLAYLIST_NOTE = 'the arc works for dinner';

  async function annotated() {
    const deps = makeDeps({
      replacePlaylist: vi.fn().mockResolvedValue({ persistentId: 'P-PREVIEW', trackCount: 1 }),
      deletePlaylistById: vi.fn().mockResolvedValue(1),
    });
    await setNote(deps, 'track', 'T-TEARDROP', TRACK_NOTE);
    await setNote(deps, 'playlist', 'P-LATENIGHT', PLAYLIST_NOTE);
    return deps;
  }

  it('search: full objects carry note, unannotated tracks omit it', async () => {
    const deps = await annotated();
    const out = (await handleSearch({ artist: 'Massive Attack' }, deps)) as SearchOutput;
    const byId = new Map(out.tracks.map((t) => [t.persistent_id, t]));
    expect(byId.get('T-TEARDROP')!.note).toEqual(noteShape(TRACK_NOTE));
    expect(byId.get('T-ANGEL')!.note).toBeUndefined();
  });

  it('search: compact rows carry note in the last slot, null when unset', async () => {
    const deps = await annotated();
    const out = (await handleSearch(
      { artist: 'Massive Attack', compact: true },
      deps,
    )) as CompactSearchOutput;
    expect(COMPACT_TRACK_FIELDS[COMPACT_TRACK_FIELDS.length - 1]).toBe('note');
    const byId = new Map(out.tracks.map(({ track }) => [track[0], track]));
    expect(byId.get('T-TEARDROP')!.at(-1)).toEqual(noteShape(TRACK_NOTE));
    expect(byId.get('T-ANGEL')!.at(-1)).toBeNull();
  });

  it('get_track_context: seed, same-artist, co-occurring, and multi-seed all carry notes', async () => {
    const deps = await annotated();
    await setNote(deps, 'track', 'T-ANGEL', 'same-artist note');
    await setNote(deps, 'track', 'T-GLORYBOX', 'co-occurring note');

    const full = (await handleGetTrackContext(
      { track_id: 'T-TEARDROP' },
      deps,
    )) as TrackContextOutput;
    expect(full.seed.note).toEqual(noteShape(TRACK_NOTE));
    expect(full.same_artist.find((t) => t.persistent_id === 'T-ANGEL')!.note!.body).toBe(
      'same-artist note',
    );
    expect(full.co_occurring_tracks.find((t) => t.persistent_id === 'T-GLORYBOX')!.note!.body).toBe(
      'co-occurring note',
    );
    expect(
      full.co_occurring_tracks.find((t) => t.persistent_id === 'T-ROADS')!.note,
    ).toBeUndefined();

    const compact = (await handleGetTrackContext(
      { track_id: 'T-TEARDROP', compact: true },
      deps,
    )) as CompactTrackContextOutput;
    expect(compact.seed.at(-1)).toEqual(noteShape(TRACK_NOTE));
    expect(
      compact.co_occurring_tracks.find((c) => c.track[0] === 'T-GLORYBOX')!.track.at(-1),
    ).toEqual(noteShape('co-occurring note'));

    const multi = (await handleGetTrackContext(
      { seed_ids: ['T-TEARDROP', 'T-ROADS'] },
      deps,
    )) as MultiSeedContextOutput;
    expect(multi.seeds.find((t) => t.persistent_id === 'T-TEARDROP')!.note!.body).toBe(TRACK_NOTE);
    expect(
      multi.co_occurring_tracks.find((t) => t.persistent_id === 'T-GLORYBOX')!.note!.body,
    ).toBe('co-occurring note');
  });

  it('inspect_tracklist: resolved draft tracks carry notes', async () => {
    const deps = await annotated();
    const out = (await handleInspectTracklist(
      { track_ids: ['T-TEARDROP', 'T-ANGEL'] },
      deps,
    )) as InspectTracklistOutput;
    expect(out.tracks[0]!.note).toEqual(noteShape(TRACK_NOTE));
    expect(out.tracks[1]!.note).toBeUndefined();
  });

  it('list_playlists: annotated playlists carry note, others omit it', async () => {
    const deps = await annotated();
    const out = (await handleListPlaylists({}, deps)) as ListPlaylistsOutput;
    const byId = new Map(out.playlists.map((p) => [p.id, p]));
    expect(byId.get('P-LATENIGHT')!.note).toEqual(noteShape(PLAYLIST_NOTE));
    expect(byId.get('P-TRIPHOP')!.note).toBeUndefined();
  });

  it('preview_playlist: the slot note comes back once set, omitted before', async () => {
    const deps = await annotated();
    const before = (await handlePreviewPlaylist(
      { track_ids: ['T-TEARDROP'] },
      deps,
    )) as PreviewPlaylistOutput;
    expect(before).toEqual({ playlist_id: 'P-PREVIEW', track_count: 1 });

    await setNote(deps, 'playlist', 'P-PREVIEW', 'draft 3: user wants a softer close');
    const after = (await handlePreviewPlaylist(
      { track_ids: ['T-TEARDROP'] },
      deps,
    )) as PreviewPlaylistOutput;
    expect(after.note).toEqual(noteShape('draft 3: user wants a softer close'));
  });

  it('delete_playlist: the note goes with the playlist', async () => {
    const deps = await annotated();
    await handleDeletePlaylist({ playlist_id: 'P-LATENIGHT' }, deps);
    expect(deps.cacheInstance.getNote('playlist', 'P-LATENIGHT')).toBeNull();
    // Track notes are untouched — only the playlist went.
    expect(deps.cacheInstance.getNote('track', 'T-TEARDROP')!.body).toBe(TRACK_NOTE);
  });

  it('never affects search matching or ordering', async () => {
    const deps = await annotated();
    const before = (await handleSearch({ limit: 10 }, deps)) as SearchOutput;
    await setNote(
      deps,
      'track',
      'T-BARE',
      'Teardrop Massive Attack — a note that reads like a query',
    );
    const after = (await handleSearch({ limit: 10 }, deps)) as SearchOutput;
    expect(after.tracks.map((t) => t.persistent_id)).toEqual(
      before.tracks.map((t) => t.persistent_id),
    );
    const byQuery = (await handleSearch({ query: 'teardrop' }, deps)) as SearchOutput;
    expect(byQuery.tracks.map((t) => t.persistent_id)).toEqual(['T-TEARDROP']);
  });
});
