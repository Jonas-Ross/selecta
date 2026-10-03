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
      // Played from the playlist, so Music.app carries on through it and AutoMix has a next track.
      Music.play(pl.tracks[args.index]);
      if (args.position !== undefined) Music.playerPosition = args.position;
      return JSON.stringify({ playlistId: pl.persistentID(), player: readPlayer() });
    `,
  );
}
