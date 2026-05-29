import { describe, it, expect } from 'vitest';
import { buildReadPlaylistScript } from '../src/bridge/scripts/read_playlist.js';
import { buildFindPlaylistByNameScript } from '../src/bridge/scripts/find_playlist_by_name.js';

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
});
