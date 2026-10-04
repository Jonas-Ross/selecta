import { describe, it, expect } from 'vitest';
import { buildReadPlaylistScript } from '../src/bridge/scripts/read_playlist.js';
import { buildFindPlaylistByNameScript } from '../src/bridge/scripts/find_playlist_by_name.js';
import { buildReorderTracksScript } from '../src/bridge/scripts/edit_playlist.js';
import { buildDeletePlaylistByIdScript } from '../src/bridge/scripts/delete_playlist.js';
import { buildSetLovedScript, buildSetRatingScript } from '../src/bridge/scripts/track_signal.js';
import { buildClonePlaylistScript } from '../src/bridge/scripts/write_playlist.js';

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

  it('buildClonePlaylistScript snapshots and resolves the source before creating', () => {
    const args = { name: 'Final', sourcePlaylistId: 'P-SOURCE', description: 'approved' };
    const script = buildClonePlaylistScript(args);

    expect(script).toContain(JSON.stringify(args));
    expect(script.indexOf('playlistNotFound')).toBeLessThan(script.indexOf('Music.make'));
    expect(script.indexOf('sourceNotUser')).toBeLessThan(script.indexOf('Music.make'));
    expect(script.indexOf('invalidSourceTrackCount')).toBeLessThan(script.indexOf('Music.make'));
    expect(script.indexOf('source.tracks.persistentID()')).toBeLessThan(
      script.indexOf('Music.make'),
    );
    expect(script.indexOf('missingTrackIds')).toBeLessThan(script.indexOf('Music.make'));
    expect(script).toContain('addTracksInOrder(pl, sourceTrackPersistentIds)');
  });

  it('buildClonePlaylistScript recovers a reserved slot by name only after the ID lookup misses', () => {
    const args = {
      name: 'Final',
      sourcePlaylistId: 'P-STALE',
      reservedSourceName: 'Selecta Preview',
    };
    const script = buildClonePlaylistScript(args);

    expect(script).toContain(JSON.stringify(args));
    const idLookup = script.indexOf('whose({ persistentID: args.sourcePlaylistId })');
    const nameLookup = script.indexOf('plainUserPlaylistsNamed(args.reservedSourceName, Infinity)');

    expect(idLookup).toBeGreaterThan(-1);
    expect(nameLookup).toBeGreaterThan(idLookup);
    // Ambiguity and absence are decided before anything is created.
    expect(script.indexOf('ambiguousSource')).toBeLessThan(script.indexOf('Music.make'));
    expect(script.indexOf('playlistNotFound')).toBeLessThan(script.indexOf('Music.make'));
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
    expect(script.indexOf('missingTrackIds')).toBeLessThan(script.indexOf('.rating = args.rating'));
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

describe('preview navigation script contract', () => {
  it('guards identity and exact order before revealing, with no playback or mutation commands', async () => {
    const { buildOpenPreviewScript } = await import('../src/bridge/scripts/open_preview.js');
    const script = buildOpenPreviewScript({ expectedTrackIds: ['A', 'B', 'A'] });

    for (const guard of ['playlistNotFound', 'notEditable', 'ambiguousPreview', 'orderDrifted']) {
      expect(script.indexOf(guard)).toBeGreaterThan(-1);
      expect(script.indexOf(guard)).toBeLessThan(script.indexOf('Music.reveal(pl)'));
    }

    expect(script).toContain("String(pl.class()) === 'userPlaylist' && !pl.smart()");
    expect(script.indexOf('const slots = matches.filter')).toBeLessThan(
      script.indexOf('slots.length !== 1'),
    );
    expect(script).toContain('JSON.stringify(ids) !== JSON.stringify(args.expectedTrackIds)');
    expect(script).toContain('Music.activate()');
    expect(script).not.toMatch(
      /Music\.(play\(|playpause\(|nextTrack\(|previousTrack\(|make\(|delete\(|duplicate\()/,
    );
  });
});

describe('artwork read script contract', () => {
  const A = '0123456789ABCDEF';
  const B = 'FEDCBA9876543210';

  it('passes IDs and the directory only as JSON args, checking Music is running first', async () => {
    const { buildReadArtworkScript } = await import('../src/bridge/scripts/read_artwork.js');
    const args = { trackIds: [A, B], dir: '/tmp/art "dir"' };
    const script = buildReadArtworkScript(args);

    expect(script).toContain(JSON.stringify(args));
    expect(script).toContain("args.dir + '/' + name");
    expect(script.indexOf('Music.running()')).toBeLessThan(script.indexOf('$.NSAppleScript'));
    expect(script).toContain('raw data of artwork 1');
    // Only -1728 reads as no art; other per-track codes come back as failures.
    expect(script).toContain(
      "if (code !== -1728) written[id] = { error: 'Apple event error ' + code };",
    );
    // A failed write fails the batch rather than reading as no art.
    expect(script).toContain("throw new Error('Cannot write artwork into '");
    expect(script).not.toMatch(
      /Music\.(make|delete|duplicate|move|add)\(|\.rating =|\.favorited =/,
    );
  });

  it('sniffs JPEG and PNG by their signature bytes', async () => {
    const { buildReadArtworkScript } = await import('../src/bridge/scripts/read_artwork.js');
    const script = buildReadArtworkScript({ trackIds: [A], dir: '/tmp' });

    expect(script).toContain(JSON.stringify(Buffer.from('ffd8ff', 'hex').toString('base64')));
    expect(script).toContain(JSON.stringify(Buffer.from('89504e470d0a', 'hex').toString('base64')));
  });

  it.each([
    { trackIds: ['0123456789abcdef'], dir: '/tmp' },
    { trackIds: ['0123456789ABCDE" & do shell script "x'], dir: '/tmp' },
    { trackIds: ['0123456789ABCDEF0'], dir: '/tmp' },
    { trackIds: [A], dir: 'relative/dir' },
    { trackIds: Array.from({ length: 41 }, () => A), dir: '/tmp' },
  ])('refuses arguments that could reach AppleScript source: %j', async (args) => {
    const { buildReadArtworkScript } = await import('../src/bridge/scripts/read_artwork.js');

    expect(() => buildReadArtworkScript(args)).toThrow(
      expect.objectContaining({ errorCode: 'validation_error' }),
    );
  });
});

describe('player script contract', () => {
  const NO_WRITES = /Music\.(make|delete|duplicate|move|add)\(|\.rating =|\.favorited =/;

  it('reads the player without launching Music.app or changing anything', async () => {
    const { buildReadPlayerScript } = await import('../src/bridge/scripts/player.js');
    const script = buildReadPlayerScript();

    expect(script.indexOf('Music.running()')).toBeLessThan(script.indexOf('Music.playerState()'));
    expect(script).not.toMatch(/Music\.(play|pause|playpause|activate)\(|playerPosition =/);
    expect(script).not.toMatch(NO_WRITES);
  });

  const on = { playlistId: 'P-SLOT', index: 2, trackId: 'T' };

  it('acts only while Music.app is still on the entry the caller saw', async () => {
    const { buildControlPlayerScript } = await import('../src/bridge/scripts/player.js');
    const script = buildControlPlayerScript({ action: 'pause', on });

    expect(script.indexOf('elsewhere')).toBeLessThan(script.indexOf('Music.pause()'));
    expect(script).toContain('Music.currentPlaylist.persistentID() === args.on.playlistId');
    expect(script).toContain('t.index() === args.on.index');
    expect(script).toContain('t.persistentID() === args.on.trackId');
    // Every pause attempt re-checks the entry first.
    expect(script).toContain(
      'if (!here()) return JSON.stringify({ elsewhere: true });\n          Music.pause();',
    );
    // Fast-forwarding or rewinding is paused too, and only paused or stopped reads back as done.
    expect(script).toContain("if (args.action === 'pause' && !silent(state))");
    expect(script).toContain('paused = silent(String(Music.playerState()));');
  });

  it('acts on a preview matched by name only while it is the one playlist of that name', async () => {
    const { buildControlPlayerScript } = await import('../src/bridge/scripts/player.js');
    const script = buildControlPlayerScript({
      action: 'pause',
      on: { ...on, slot: 'Selecta Preview' },
    });

    expect(script).toContain(
      'if (named.length > 1) return JSON.stringify({ ambiguousPreview: true });',
    );
    expect(script).toContain('named[0].persistentID() !== args.on.playlistId');
    expect(script.indexOf('named.length > 1')).toBeLessThan(script.indexOf('Music.pause()'));
    // A smart or special playlist sharing the name is never the slot.
    expect(script).toContain('!pl.smart()');
  });

  it('resumes only what is paused and seeks only what is loaded', async () => {
    const { buildControlPlayerScript } = await import('../src/bridge/scripts/player.js');

    expect(
      buildControlPlayerScript({ action: 'resume', on }).indexOf('Music.shuffleEnabled()'),
    ).toBeLessThan(buildControlPlayerScript({ action: 'resume', on }).indexOf('Music.play()'));
    const resume = buildControlPlayerScript({ action: 'resume', on });

    expect(resume).toContain("if (args.action === 'resume' && state === 'paused') {");
    expect(resume.indexOf('Music.play()')).toBeLessThan(resume.indexOf('stillPaused'));
    const seek = buildControlPlayerScript({ action: 'seek', position: 60, on });

    expect(seek).toContain("if (args.action === 'seek' && state !== 'stopped') {");
    // Clamped inside the track and read back, as a play's seek is.
    expect(seek).toContain(
      'Math.min(args.position, Math.max(0, Music.currentTrack.duration() - 1))',
    );
    expect(seek.indexOf('Music.playerPosition = goal')).toBeLessThan(seek.indexOf('seekMissed'));

    // Both re-check the entry right before acting, after the slot lookup; a resume re-reads shuffle too.
    expect(seek).toContain(
      'if (!here()) return JSON.stringify({ elsewhere: true });\n        Music.playerPosition = goal;',
    );
    // The slow order read comes first; the entry and shuffle are read once more right before the play.
    expect(resume.replace(/\s+/g, ' ')).toContain(
      'return JSON.stringify({ orderDrifted: true }); } if (!here()) return JSON.stringify({ elsewhere: true }); // Read again last too, since shuffle can be switched on while the checks above settle. if (Music.shuffleEnabled()) return JSON.stringify({ shuffled: true }); Music.play();',
    );

    expect(buildControlPlayerScript({ action: 'pause', on })).not.toMatch(NO_WRITES);
    expect(() => buildControlPlayerScript({ action: 'seek', position: -1, on })).toThrow(
      expect.objectContaining({ errorCode: 'validation_error' }),
    );
  });

  it('plays from the preview only after its identity and full order check out', async () => {
    const { buildPlayPreviewScript } = await import('../src/bridge/scripts/player.js');
    const script = buildPlayPreviewScript({ expectedTrackIds: ['A', 'B', 'A'], index: 2 });

    for (const guard of ['playlistNotFound', 'notEditable', 'ambiguousPreview', 'orderDrifted'])
      expect(script.indexOf(guard)).toBeLessThan(script.indexOf('Music.play(pl)'));

    expect(script).toContain('JSON.stringify(ids) !== JSON.stringify(args.expectedTrackIds)');
    // One track played alone stops Music.app after it, so the playlist is what starts.
    expect(script).not.toContain('Music.play(pl.tracks');
    // The volume is the user's; quiet steps pause instead.
    // A restarted queue is paused as soon as it plays, before anything waits on it.
    expect(script.indexOf('Music.play(pl)')).toBeLessThan(
      script.indexOf('if (!quiet) return true;'),
    );
    expect(script).not.toContain('soundVolume');
    // A quiet route pauses only the record it starts from, and aborts if Music moved meanwhile.
    expect(script).toContain('if (quiet && !(still(from) && pause() && ours()))');
    expect(script.indexOf('if (quiet && !(still(from) && pause() && ours()))')).toBeLessThan(
      script.indexOf('Music.nextTrack()'),
    );
    // Steps within the queue only when the caller vouches for it; otherwise it starts over.
    expect(script.indexOf('if (restart)')).toBeLessThan(script.indexOf('Music.play(pl)'));
    // Going back within a trusted queue steps with previousTrack.
    expect(script).toContain('Music.previousTrack()');
    expect(script).not.toContain('Music.stop()');

    // Every step and the final seek re-check the entry they start from, so a record the user
    // picked mid-route, or other music, is never stepped from or seeked.
    for (const [check, act] of [
      ['!still(entry + 1)', 'Music.playerPosition = 0;'],
      ['!still(entry - 1)', 'Music.nextTrack();'],
      ['!still(target)', 'Music.playerPosition = goal;'],
    ])
      expect(script.replace(/\s+/g, ' ')).toContain(
        `if (${check}) return JSON.stringify({ stepMissed: true }); ${act}`,
      );

    // A step that times out onto a record other than its source or destination counts as picked.
    expect(script).toContain('if (now !== false && now !== entry && now !== prev) picked = true;');
    expect(script).toContain(
      'if (!step(entry, entry + 1)) return JSON.stringify({ stepMissed: true });',
    );
    expect(script).toContain(
      'if (!step(entry, entry - 1)) return JSON.stringify({ stepMissed: true });',
    );

    expect(script).toContain('const restart = args.restart === true || from < 1;');
    expect(script.indexOf('Music.shuffleEnabled()')).toBeLessThan(script.indexOf('Music.play(pl)'));
    // Checked again after the route settles, right before the final resume.
    expect(script.lastIndexOf('Music.shuffleEnabled()')).toBeGreaterThan(
      script.indexOf('orderDrifted: true'),
    );
    expect(script.lastIndexOf('Music.shuffleEnabled()')).toBeLessThan(
      script.lastIndexOf('Music.play();'),
    );
    // A start that went wrong is paused, and reported if Music won't pause.
    expect(script.indexOf('} finally {')).toBeLessThan(script.indexOf('leftPlaying'));
    // Past the seek, cleanup re-reads the entry first, so a record picked during the last checks plays on.
    expect(script.indexOf('reached = true;')).toBeLessThan(
      script.indexOf('if (!inOrder()) return'),
    );
    expect(script.replace(/\s+/g, ' ')).toContain(
      'if (!landed && reached) try { still(target); } catch (e) {} if (!landed && !picked && !pause())',
    );
    // No pause, cleanup's included, ever lands on music the user moved on to.
    expect(script).toContain('if (!ours()) return true;');
    expect(script.indexOf('if (!ours()) return true;')).toBeLessThan(
      script.indexOf('Music.pause();'),
    );
    // Its pauses read back as done only once paused or stopped, not merely off 'playing'.
    expect(script).toContain('if (until(silent)) return true;');
    expect(script).toContain("return now === 'paused' || now === 'stopped';");
    // The restart's own pause re-checks the playlist first, as every other pause does.
    expect(script.replace(/\s+/g, ' ')).toContain(
      'if (!ours()) return (moved = true); Music.pause();',
    );
    // A restarted play that seeks is paused first, so the record's start isn't heard.
    expect(script).toContain('(restart || from !== target) && (args.position || 0) > 0');
    // The order and target are re-read right before resuming, and the resume must read back.
    expect(script.lastIndexOf('orderDrifted')).toBeLessThan(script.lastIndexOf('Music.play();'));
    expect(script).toContain(
      'return ours() && JSON.stringify(now) === JSON.stringify(args.expectedTrackIds)',
    );
    // A repeated track at another occurrence fails the index check.
    expect(script).toContain('Music.currentTrack.index() === target &&');
    expect(script.lastIndexOf('Music.play();')).toBeLessThan(script.indexOf('stillPaused'));
    // The resume re-checks the entry and the full order after the shuffle and state reads.
    expect(script.replace(/\s+/g, ' ')).toContain(
      'if (!still(target)) return JSON.stringify({ stepMissed: true }); if (!inOrder()) return JSON.stringify({ orderDrifted: true }); if (Music.shuffleEnabled()) return JSON.stringify({ shuffled: true }); Music.play();',
    );
    // A record the user picked mid-route is never paused by the cleanup.
    expect(script).toContain('if (now !== false && now !== index) picked = true;');
    expect(script).toContain('if (!landed && !picked && !pause())');
    // A record picked while the restart settles counts too, even before the first is heard.
    expect(script).toContain('if (!started) still(1);');
    expect(script.indexOf('if (!started) still(1);')).toBeLessThan(
      script.indexOf('if (moved || !started)'),
    );
    // A seek that never lands fails before anything resumes.
    expect(script.indexOf('seekMissed')).toBeLessThan(script.lastIndexOf('Music.play();'));
    expect(script).not.toMatch(NO_WRITES);
  });

  it.each([
    { expectedTrackIds: ['A'], index: 1 },
    { expectedTrackIds: ['A'], index: -1 },
    { expectedTrackIds: ['A'], index: 0.5 },
    { expectedTrackIds: ['A'], index: 0, position: Number.NaN },
  ])('refuses %j before any script runs', async (input) => {
    const { buildPlayPreviewScript } = await import('../src/bridge/scripts/player.js');

    expect(() => buildPlayPreviewScript(input)).toThrow(
      expect.objectContaining({ errorCode: 'validation_error' }),
    );
  });
});
