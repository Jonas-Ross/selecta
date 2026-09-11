import { describe, expect, it } from 'vitest';
import { buildTracklistInspection } from '../src/domain/tracklist_inspection.js';
import {
  COMPACT_TRACK_FIELDS,
  projectApiTrack,
  toApiTrack,
  toCompactApiTrack,
  toInspectedTrack,
} from '../src/domain/track_projections.js';
import type { TrackRow } from '../src/types/cache.js';

const bare: TrackRow = {
  persistentId: 'T-BARE',
  title: null,
  artist: null,
  albumArtist: null,
  album: null,
  genre: null,
  year: null,
  durationSeconds: null,
  bpm: null,
  trackNumber: null,
  discNumber: null,
  dateAdded: null,
  lastPlayed: null,
  playCount: 0,
  skipCount: 0,
  rating: null,
  loved: 0,
  disliked: 0,
  comments: null,
  locationKind: null,
  musicalKey: null,
  danceability: null,
  noteBody: null,
  noteCreatedAt: null,
  noteUpdatedAt: null,
};
const populated: TrackRow = {
  ...bare,
  persistentId: 'T-FULL',
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  genre: 'RAW Genre',
  year: 2026,
  durationSeconds: 210.25,
  bpm: 118.456,
  musicalKey: 'F# minor',
  danceability: 0.736,
  locationKind: 'cloud',
  playCount: 12,
  skipCount: 1,
  rating: 90,
  loved: 1,
  disliked: 1,
  dateAdded: '2026-01-01T00:00:00.000Z',
  lastPlayed: '2026-09-01T00:00:00.000Z',
  noteBody: 'Keep this version.',
  noteCreatedAt: '2026-09-01T01:00:00.000Z',
  noteUpdatedAt: '2026-09-02T01:00:00.000Z',
};
const noteJson =
  '{"body":"Keep this version.","created_at":"2026-09-01T01:00:00.000Z","updated_at":"2026-09-02T01:00:00.000Z"}';
const fullJson =
  '{"persistent_id":"T-FULL","title":"Title","artist":"Artist","album":"Album","year":2026,"genre":"RAW Genre","duration_seconds":210.25,"location_kind":"cloud","bpm":118.5,"musical_key":"F# minor","danceability":0.74,"note":' +
  noteJson +
  ',"signal":{"play_count":12,"skip_count":1,"rating":4.5,"loved":true,"disliked":true,"last_played":"2026-09-01T00:00:00.000Z","date_added":"2026-01-01T00:00:00.000Z"}}';
const inspectedJson =
  '{"persistent_id":"T-FULL","title":"Title","artist":"Artist","album":"Album","duration_seconds":210.25,"bpm":118.5,"musical_key":"F# minor","danceability":0.74,"note":' +
  noteJson +
  ',"signal":{"play_count":12,"skip_count":1,"rating":4.5,"loved":true}}';

describe('serialized track contracts', () => {
  it('excludes future full-track and signal fields from reduced contracts', () => {
    const full = toApiTrack(populated);
    const extended = {
      ...full,
      future_track_fact: 'not an inspection field',
      signal: { ...full.signal, future_signal_fact: 42 },
    };
    const inspected = toInspectedTrack(extended);

    expect(JSON.stringify(inspected)).toBe(inspectedJson);
    expect(Object.keys(inspected.signal)).toEqual(['play_count', 'skip_count', 'rating', 'loved']);
    expect(inspected.note?.body).toBe('Keep this version.');
    expect(toCompactApiTrack(extended)).toEqual(toCompactApiTrack(full));
  });

  it('preserves the full field order, note, units and precision', () => {
    expect(JSON.stringify(toApiTrack(populated))).toBe(fullJson);
    expect(JSON.stringify(projectApiTrack(populated, false))).toBe(fullJson);
  });

  it('characterizes inspection field order including its existing note', () => {
    expect(JSON.stringify(buildTracklistInspection([populated]).tracks[0])).toBe(inspectedJson);
    expect(Object.keys(buildTracklistInspection([populated]).tracks[0]!)).toEqual([
      'persistent_id',
      'title',
      'artist',
      'album',
      'duration_seconds',
      'bpm',
      'musical_key',
      'danceability',
      'note',
      'signal',
    ]);
  });

  it('omits missing facts from full and inspected tracks and uses null compact slots', () => {
    const json = '{"persistent_id":"T-BARE","signal":{"play_count":0,"skip_count":0}}';

    expect(JSON.stringify(toApiTrack(bare))).toBe(json);
    expect(JSON.stringify(buildTracklistInspection([bare]).tracks[0])).toBe(json);
    expect(JSON.stringify(projectApiTrack(bare, true))).toBe(
      '["T-BARE",null,null,null,null,null,null,null,null,null,0,0,null,null,null,null,null,null]',
    );
  });

  it('keeps compact field order, values and notes explicit', () => {
    expect(COMPACT_TRACK_FIELDS).toEqual([
      'persistent_id',
      'title',
      'artist',
      'album',
      'year',
      'genre',
      'duration_seconds',
      'bpm',
      'musical_key',
      'danceability',
      'signal.play_count',
      'signal.skip_count',
      'signal.rating',
      'signal.loved',
      'signal.disliked',
      'signal.last_played',
      'signal.date_added',
      'note',
    ]);
    expect(JSON.stringify(toCompactApiTrack(toApiTrack(populated)))).toBe(
      '["T-FULL","Title","Artist","Album",2026,"RAW Genre",210.25,118.5,"F# minor",0.74,12,1,4.5,true,true,"2026-09-01T00:00:00.000Z","2026-01-01T00:00:00.000Z",' +
        noteJson +
        ']',
    );
  });

  it('preserves available zero values and omits false signal flags', () => {
    const row = { ...bare, durationSeconds: 0, bpm: 0, danceability: 0, rating: 0 };

    expect(JSON.stringify(buildTracklistInspection([row]).tracks[0])).toBe(
      '{"persistent_id":"T-BARE","duration_seconds":0,"bpm":0,"danceability":0,"signal":{"play_count":0,"skip_count":0,"rating":0}}',
    );
  });
});
