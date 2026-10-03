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

export type PlayerControl =
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'seek'; position: number };

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
        for (let tries = 0; tries < 60; tries++) {
          try { if (ok()) return true; } catch (e) {}
          delay(0.05);
        }
        return false;
      }
      const at = function () {
        return Music.currentPlaylist.persistentID() === pl.persistentID() &&
          Music.currentTrack.index();
      };
      const volume = Music.soundVolume();
      Music.soundVolume = 0;
      try {
        Music.play(pl);
        // Shuffle starts the playlist anywhere, so the first entry is the proof it's in order.
        for (let step = 0; step <= args.index; step++) {
          if (step > 0) Music.nextTrack();
          if (!until(function () { return at() === step + 1; })) {
            Music.pause();
            return JSON.stringify({ stepMissed: true });
          }
        }
        Music.playerPosition = args.position === undefined ? 0 : args.position;
        until(function () { return Math.abs(Music.playerPosition() - (args.position || 0)) < 2; });
      } finally {
        Music.soundVolume = volume;
      }
      return JSON.stringify({ playlistId: pl.persistentID(), player: readPlayer() });
    `,
  );
}
