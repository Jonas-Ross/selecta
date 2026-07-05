import { describe, it, expect } from 'vitest';
import { buildReadPlaylistScript } from '../src/bridge/scripts/read_playlist.js';
import { buildFindPlaylistByNameScript } from '../src/bridge/scripts/find_playlist_by_name.js';
import { buildReorderTracksScript } from '../src/bridge/scripts/edit_playlist.js';
import { buildDeletePlaylistByIdScript } from '../src/bridge/scripts/delete_playlist.js';
import { buildSetLovedScript, buildSetRatingScript } from '../src/bridge/scripts/track_signal.js';

describe('JXA script builders interpolate args as JSON, never via shell quoting', () => {
  it('buildReadPlaylistScript embeds the JSON-stringified args', () => {
    const args = { persistentId: 'ABC123' };
    const script = buildReadPlaylistScript(args);
    expect(script).toContain(JSON.stringify(args));
  });

  it('buildReadPlaylistScript safely encodes quotes and backslashes', () => {
    const args = { persistentId: 'a"b\\c' };
    const script = buildReadPlaylistScript(args);
    // The JSON-encoded form is present; the raw unescaped value is not.
    expect(script).toContain(JSON.stringify(args));
    expect(script).not.toContain('persistentId: a"b\\c');
  });

  it('buildFindPlaylistByNameScript embeds the JSON-stringified args', () => {
    const args = { name: 'Selecta Test' };
    const script = buildFindPlaylistByNameScript(args);
    expect(script).toContain(JSON.stringify(args));
  });

  it('buildReorderTracksScript embeds the JSON-stringified args', () => {
    const args = { playlistId: 'P1', order: [2, 0, 1], expectedTrackIds: ['T1', 'T2', 'T3'] };
    const script = buildReorderTracksScript(args);
    expect(script).toContain(JSON.stringify(args));
  });

  it('buildReorderTracksScript safely encodes quotes and backslashes', () => {
    const args = { playlistId: 'a"b\\c', order: [0], expectedTrackIds: ['T1'] };
    const script = buildReorderTracksScript(args);
    expect(script).toContain(JSON.stringify(args));
    expect(script).not.toContain('playlistId: a"b\\c');
  });

  it('buildSetLovedScript writes the modern favorited property, resolving tracks first', () => {
    const args = { trackIds: ['T1', 'T2'], loved: true };
    const script = buildSetLovedScript(args);
    expect(script).toContain(JSON.stringify(args));
    // Modern Music.app has no 'loved' — writes must target 'favorited'
    // (docs/music-app.md, library contents).
    expect(script).toContain('.favorited = args.loved');
    // Resolution (and its missingTrackIds bail-out) must precede the write.
    expect(script.indexOf('missingTrackIds')).toBeLessThan(
      script.indexOf('.favorited = args.loved'),
    );
  });

  it('buildSetRatingScript embeds the args and resolves tracks before writing', () => {
    const args = { trackIds: ['T1'], rating: 80 };
    const script = buildSetRatingScript(args);
    expect(script).toContain(JSON.stringify(args));
    expect(script.indexOf('missingTrackIds')).toBeLessThan(
      script.indexOf('.rating = args.rating'),
    );
    // Computed (album-derived) ratings must never read back as user signal —
    // the readback goes through the ratingKind guard.
    expect(script).toContain("t.ratingKind() === 'user'");
  });

  it('buildDeletePlaylistByIdScript embeds the args and guards editability before deleting', () => {
    const args = { persistentId: 'P1' };
    const script = buildDeletePlaylistByIdScript(args);
    expect(script).toContain(JSON.stringify(args));
    // The kind guard must sit between lookup and delete — delete_playlist is
    // irreversible, and only plain user playlists are fair game.
    expect(script.indexOf("!== 'user'")).toBeGreaterThan(-1);
    expect(script.indexOf("!== 'user'")).toBeLessThan(script.indexOf('Music.delete'));
  });
});

describe('JXA wrapper', () => {
  it('never defines a run() handler — osascript would invoke it implicitly and execute the body twice', () => {
    // docs/music-app.md, JXA: `function run() {...} run();` runs the body
    // TWICE per osascript process (top-level call + implicit run handler).
    const script = buildReadPlaylistScript({ persistentId: 'ABC123' });
    expect(script).not.toMatch(/function\s+run\s*\(/);
  });
});
