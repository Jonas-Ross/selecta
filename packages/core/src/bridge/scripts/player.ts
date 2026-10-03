// Music.app's transport, for the desktop app's Listen screen. Reading and
// pausing never launch Music.app; playing starts only from the reserved
// preview, and only while its live order is the one the caller expects.
import { PREVIEW_PLAYLIST_NAME } from '../../operations/playlist.js';
import { BridgeError } from '../../types/errors.js';
import { PREVIEW_SLOT } from './preview_slot.js';
import { wrapJxaScript } from './wrap.js';

// Stopped has no current track, and a track playing outside any playlist has
// no current playlist (docs/music-app.md, Playback), so each part is optional.
const READ_PLAYER = `
      function readPlayer() {
        if (!Music.running()) return { running: false };
        const out = { running: true, state: String(Music.playerState()) };
        if (out.state === 'stopped') return out;
        try {
          const t = Music.currentTrack;
          out.track = { persistentId: t.persistentID(), duration: t.duration() };
          out.position = Music.playerPosition();
          try { out.index = t.index(); } catch (e) {}
          try {
            const cp = Music.currentPlaylist;
            out.playlist = { persistentId: cp.persistentID(), name: cp.name() };
          } catch (e) {}
        } catch (e) {}
        return out;
      }`;

export function buildReadPlayerScript(): string {
  return wrapJxaScript(
    {},
    `${READ_PLAYER}
      return JSON.stringify(readPlayer());
    `,
  );
}

// The entry the caller saw playing; the control acts only while Music.app is still on it.
export type PlayerEntry = { playlistId: string; index: number; trackId: string };

export type PlayerControl = (
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'seek'; position: number }
) & { on: PlayerEntry };

export function buildControlPlayerScript(input: PlayerControl): string {
  if (input.action === 'seek' && !(Number.isFinite(input.position) && input.position >= 0))
    throw new BridgeError(
      'validation_error',
      'Seek position must be a non-negative number of seconds.',
    );

  return wrapJxaScript(
    input,
    `${READ_PLAYER}
      if (!Music.running()) return JSON.stringify({ running: false });
      const state = String(Music.playerState());
      try {
        const t = Music.currentTrack;
        if (Music.currentPlaylist.persistentID() !== args.on.playlistId ||
          t.index() !== args.on.index || t.persistentID() !== args.on.trackId) {
          return JSON.stringify({ elsewhere: true });
        }
      } catch (e) {
        return JSON.stringify({ elsewhere: true });
      }
      if (args.action === 'pause' && state === 'playing') Music.pause();
      // play() with nothing paused would start whatever Music.app last had queued.
      if (args.action === 'resume' && state === 'paused') Music.play();
      if (args.action === 'seek' && state !== 'stopped') Music.playerPosition = args.position;
      // A read straight after pause() still says playing; the change lands a beat later.
      delay(0.3);
      return JSON.stringify(readPlayer());
    `,
  );
}

/** Play entry `index` (0-based) of the preview, optionally from `position` seconds. */
export function buildPlayPreviewScript(input: {
  expectedTrackIds: string[];
  index: number;
  position?: number;
}): string {
  if (
    !Number.isInteger(input.index) ||
    input.index < 0 ||
    input.index >= input.expectedTrackIds.length
  )
    throw new BridgeError('validation_error', 'Play index is outside the preview.');

  if (input.position !== undefined && !(Number.isFinite(input.position) && input.position >= 0))
    throw new BridgeError(
      'validation_error',
      'Play position must be a non-negative number of seconds.',
    );

  return wrapJxaScript(
    { ...input, name: PREVIEW_PLAYLIST_NAME },
    `${READ_PLAYER}${PREVIEW_SLOT}
      // Playing one track stops Music.app after it; playing the playlist gives it a queue
      // to carry on through, so start there and step to the entry, muted.
      // Each command lands a beat late, so every step waits until it reads back.
      function until(ok) {
        for (let tries = 0; tries < 100; tries++) {
          try { if (ok()) return true; } catch (e) {}
          delay(0.05);
        }
        return false;
      }
      const at = function () {
        return Music.currentPlaylist.persistentID() === pl.persistentID() &&
          Music.currentTrack.index();
      };
      // Shuffle would carry on through the draft out of order.
      if (Music.shuffleEnabled()) return JSON.stringify({ shuffled: true });
      const target = args.index + 1;
      let from = 0;
      try { if (String(Music.playerState()) !== 'stopped') from = at() || 0; } catch (e) {}
      // In the playlist already, step from there; Music.app ignores play() on the playlist
      // it is playing, and stepping back works where stop-then-play was seen to fail.
      const restart = from < 1;
      const route = restart ? 'started' : from > target ? 'back from ' + from : from < target ? 'on from ' + from : 'seek';
      const volume = Music.soundVolume();
      let landed = false;
      if (from !== target) Music.soundVolume = 0;
      try {
        if (restart) {
          Music.play(pl);
          from = 1;
        }
        // previousTrack restarts a record that's playing past its start, so rewind it first.
        for (let entry = from - 1; entry >= target; entry--) {
          Music.playerPosition = 0;
          Music.previousTrack();
          if (!until(function () { return at() === entry; })) return JSON.stringify({ stepMissed: true });
        }
        if (from > target) from = target;
        for (let entry = from; entry <= target; entry++) {
          if (entry > from) Music.nextTrack();
          if (!until(function () { return at() === entry; })) return JSON.stringify({ stepMissed: true });
        }
        // Clamped inside the track, since Music.app ignores a position past the end.
        const goal = Math.min(args.position || 0, Math.max(0, Music.currentTrack.duration() - 1));
        Music.playerPosition = goal;
        if (!until(function () { return Math.abs(Music.playerPosition() - goal) < 2; })) {
          return JSON.stringify({ seekMissed: true });
        }
        if (String(Music.playerState()) === 'paused') Music.play();
        landed = true;
      } finally {
        // A start that went wrong stays muted until Music has provably stopped playing it.
        if (!landed) {
          let stopped = false;
          for (let attempt = 0; attempt < 3 && !stopped; attempt++) {
            Music.pause();
            stopped = until(function () { return String(Music.playerState()) !== 'playing'; });
          }
          if (!stopped) return JSON.stringify({ leftMuted: true, volume: volume });
        }
        Music.soundVolume = volume;
      }
      return JSON.stringify({ playlistId: pl.persistentID(), route: route, player: readPlayer() });
    `,
  );
}
