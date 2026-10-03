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
      const here = function () {
        try {
          const t = Music.currentTrack;
          return Music.currentPlaylist.persistentID() === args.on.playlistId &&
            t.index() === args.on.index && t.persistentID() === args.on.trackId;
        } catch (e) {
          return false;
        }
      };
      if (!here()) return JSON.stringify({ elsewhere: true });
      // A pause can be ignored, so it is retried until it reads back; callers rely on it.
      // Each retry re-checks the entry, so it never pauses music the user moved on to.
      if (args.action === 'pause' && state === 'playing') {
        let paused = false;
        for (let attempt = 0; attempt < 3 && !paused; attempt++) {
          if (attempt > 0 && !here()) return JSON.stringify({ elsewhere: true });
          Music.pause();
          for (let tries = 0; tries < 20 && !paused; tries++) {
            delay(0.05);
            paused = String(Music.playerState()) !== 'playing';
          }
        }
        if (!paused) return JSON.stringify({ stillPlaying: true });
      }
      // Shuffle turned on while paused would carry on through the draft out of order.
      if (args.action === 'resume' && Music.shuffleEnabled()) return JSON.stringify({ shuffled: true });
      // play() with nothing paused would start whatever Music.app last had queued.
      if (args.action === 'resume' && state === 'paused') {
        Music.play();
        // A play can be swallowed (an open Settings window does it), so it must read back.
        let playing = false;
        for (let tries = 0; tries < 60 && !playing; tries++) {
          delay(0.05);
          playing = String(Music.playerState()) === 'playing';
        }
        if (!playing) return JSON.stringify({ stillPaused: true });
      }
      if (args.action === 'seek' && state !== 'stopped') {
        // Clamped like a play's seek, and read back since a seek can silently not land.
        const goal = Math.min(args.position, Math.max(0, Music.currentTrack.duration() - 1));
        Music.playerPosition = goal;
        let tries = 0;
        while (Math.abs(Music.playerPosition() - goal) >= 2) {
          if (++tries > 100) return JSON.stringify({ seekMissed: true });
          delay(0.05);
        }
      }
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
  restart?: boolean;
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
      // to carry on through, so start there and step to the entry while paused.
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
      // A pause fired straight after a play may not take, so each is retried until it reads back.
      // Music moved off the preview counts as paused: nothing of ours is left to stop.
      const ours = function () {
        try { return Music.currentPlaylist.persistentID() === pl.persistentID(); } catch (e) { return false; }
      };
      const pause = function () {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!ours()) return true;
          Music.pause();
          if (until(function () { return String(Music.playerState()) !== 'playing'; })) return true;
        }
        return false;
      };
      // Shuffle would carry on through the draft out of order.
      if (Music.shuffleEnabled()) return JSON.stringify({ shuffled: true });
      const target = args.index + 1;
      let from = 0;
      try { if (String(Music.playerState()) !== 'stopped') from = at() || 0; } catch (e) {}
      // Stepping within a queue the caller knows it started skips a restart; a lone track
      // reads the same from here, so anything else starts the playlist over.
      const restart = args.restart === true || from < 1;
      const route = restart ? 'started' : from > target ? 'back from ' + from : from < target ? 'on from ' + from : 'seek';
      let landed = false;
      try {
        if (restart) from = 1;
        // Paused only when records passed on the way, or a fresh record's start before the seek,
        // would be heard; one step with nothing to seek is a plain Next. Volume is the user's.
        const quiet = Math.abs(target - from) > 1 || ((restart || from !== target) && (args.position || 0) > 0);
        if (restart) {
          Music.play(pl);
          // Paused the moment it is heard playing, so only a beat of the first record leaks.
          let heard = false;
          const started = until(function () {
            if (at() !== 1) return false;
            if (String(Music.playerState()) !== 'playing') return heard;
            heard = true;
            if (!quiet) return true;
            Music.pause();
            return false;
          });
          if (!started) return JSON.stringify({ stepMissed: true });
        } else if (quiet && !pause()) return JSON.stringify({ stepMissed: true });
        // previousTrack restarts a record that's playing past its start, so rewind it first.
        for (let entry = from - 1; entry >= target; entry--) {
          Music.playerPosition = 0;
          Music.previousTrack();
          if (!until(function () { return at() === entry; })) return JSON.stringify({ stepMissed: true });
        }
        for (let entry = from + 1; entry <= target; entry++) {
          Music.nextTrack();
          if (!until(function () { return at() === entry; })) return JSON.stringify({ stepMissed: true });
        }
        // Clamped inside the track, since Music.app ignores a position past the end.
        const goal = Math.min(args.position || 0, Math.max(0, Music.currentTrack.duration() - 1));
        Music.playerPosition = goal;
        if (!until(function () { return Math.abs(Music.playerPosition() - goal) < 2; })) {
          return JSON.stringify({ seekMissed: true });
        }
        // The order is checked again here, since an edit or iCloud sync can land mid-step.
        const now = pl.tracks.length > 0 ? pl.tracks.persistentID() : [];
        if (JSON.stringify(now) !== JSON.stringify(args.expectedTrackIds) ||
          Music.currentTrack.persistentID() !== args.expectedTrackIds[args.index]) {
          return JSON.stringify({ orderDrifted: true });
        }
        if (quiet || String(Music.playerState()) === 'paused') {
          Music.play();
          if (!until(function () { return String(Music.playerState()) === 'playing'; })) {
            return JSON.stringify({ stillPaused: true });
          }
        }
        landed = true;
      } finally {
        // A start that went wrong is left paused, unless the user has moved Music elsewhere.
        if (!landed && !pause()) return JSON.stringify({ leftPlaying: true });
      }
      return JSON.stringify({ playlistId: pl.persistentID(), route: route, player: readPlayer() });
    `,
  );
}
