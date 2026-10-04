// Music.app's transport, for the desktop app's Listen screen. Reading and
// pausing never launch Music.app; playing starts only from the reserved
// preview, and only while its live order is the one the caller expects.
import { PREVIEW_PLAYLIST_NAME } from '../../operations/playlist.js';
import type { PlayerControl } from '../../types/bridge.js';
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
      if (args.on.slot !== undefined) {
        const named = Music.playlists.whose({ name: args.on.slot })()
          .filter(function (pl) {
            return pl.name() === args.on.slot && String(pl.class()) === 'userPlaylist' && !pl.smart() &&
              String(pl.specialKind()).toLowerCase() === 'none';
          });
        // A copy sharing the name makes the match ambiguous, so it is never acted on.
        if (named.length > 1) return JSON.stringify({ ambiguousPreview: true });
        if (named.length === 0 || named[0].persistentID() !== args.on.playlistId) {
          return JSON.stringify({ elsewhere: true });
        }
      }
      // A pause can be ignored, so it is retried until it reads back; callers rely on it.
      // Each attempt re-checks the entry, so it never pauses music the user moved on to.
      // Fast-forwarding and rewinding are audible too, so anything not paused or stopped is paused.
      const silent = function (now) { return now === 'paused' || now === 'stopped'; };
      if (args.action === 'pause' && !silent(state)) {
        let paused = false;
        for (let attempt = 0; attempt < 3 && !paused; attempt++) {
          if (!here()) return JSON.stringify({ elsewhere: true });
          Music.pause();
          for (let tries = 0; tries < 20 && !paused; tries++) {
            delay(0.05);
            paused = silent(String(Music.playerState()));
          }
        }
        if (!paused) return JSON.stringify({ stillPlaying: true });
      }
      // Shuffle turned on while paused would carry on through the draft out of order.
      if (args.action === 'resume' && Music.shuffleEnabled()) return JSON.stringify({ shuffled: true });
      // play() with nothing paused would start whatever Music.app last had queued.
      // Resume and seek re-check the entry last, since the slot lookup above takes time.
      if (args.action === 'resume' && state === 'paused') {
        // The slow full-order read goes first, so the entry and shuffle reads sit right before the play.
        if (args.expectedTrackIds !== undefined) {
          const pl = Music.currentPlaylist;
          const order = pl.tracks.length > 0 ? pl.tracks.persistentID() : [];
          if (JSON.stringify(order) !== JSON.stringify(args.expectedTrackIds)) return JSON.stringify({ orderDrifted: true });
        }
        if (!here()) return JSON.stringify({ elsewhere: true });
        // Read again last too, since shuffle can be switched on while the checks above settle.
        if (Music.shuffleEnabled()) return JSON.stringify({ shuffled: true });
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
        if (!here()) return JSON.stringify({ elsewhere: true });
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
      // Fast-forwarding and rewinding are audible too, so only paused or stopped reads back as done.
      const silent = function () {
        const now = String(Music.playerState());
        return now === 'paused' || now === 'stopped';
      };
      const pause = function () {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!ours()) return true;
          Music.pause();
          if (until(silent)) return true;
        }
        return false;
      };
      const target = args.index + 1;
      let from = 0;
      let wasPaused = false;
      try {
        const before = String(Music.playerState());
        wasPaused = before === 'paused';
        if (before !== 'stopped') from = at() || 0;
      } catch (e) {}
      // Stepping within a queue the caller knows it started skips a restart; a lone track
      // reads the same from here, so anything else starts the playlist over.
      const restart = args.restart === true || from < 1;
      const route = restart ? 'started' : from > target ? 'back from ' + from : from < target ? 'on from ' + from : 'seek';
      let landed = false;
      let reached = false;
      // Set when the user picks another record of the preview mid-route; cleanup leaves it playing.
      let picked = false;
      const still = function (index) {
        const now = at();
        if (now !== false && now !== index) picked = true;
        return now === index;
      };
      // Playlist and order are checked, since the user, an edit or iCloud can move them mid-step;
      // the index too, since a repeated track matches by ID at another occurrence.
      const sameTracks = function () {
        const now = pl.tracks.length > 0 ? pl.tracks.persistentID() : [];
        return JSON.stringify(now) === JSON.stringify(args.expectedTrackIds);
      };
      const inOrder = function () {
        return ours() && sameTracks() &&
          Music.currentTrack.index() === target &&
          Music.currentTrack.persistentID() === args.expectedTrackIds[args.index];
      };
      // A step that never lands onto a record other than its source or destination was the user's pick.
      const step = function (entry, prev) {
        if (until(function () { return at() === entry; })) return true;
        try { const now = at(); if (now !== false && now !== entry && now !== prev) picked = true; } catch (e) {}
        return false;
      };
      // The slot's order was read before the shuffle and player reads, so it is read again before anything moves.
      if (!sameTracks()) return JSON.stringify({ orderDrifted: true });
      // Shuffle would carry on through the draft out of order; read last, right before the queue starts.
      if (Music.shuffleEnabled()) return JSON.stringify({ shuffled: true });
      try {
        if (restart) from = 1;
        // Paused only when records passed on the way, or a fresh record's start before the seek,
        // would be heard; one step with nothing to seek is a plain Next. Volume is the user's.
        const quiet = Math.abs(target - from) > 1 || ((restart || from !== target) && (args.position || 0) > 0);
        if (restart) {
          Music.play(pl);
          // Paused the moment it is heard playing, so only a beat of the first record leaks.
          let heard = false;
          let moved = false;
          const started = until(function () {
            if (at() !== 1) return false;
            if (String(Music.playerState()) !== 'playing') return heard;
            heard = true;
            if (!quiet) return true;
            // Checked again right before pausing, so a record or music the user switched to is never paused.
            if (!still(1)) return (moved = true);
            Music.pause();
            return false;
          });
          // Elsewhere in the preview means the user picked a record, or the start never took; either way it is left alone.
          if (!started) still(1);
          if (moved || !started) return JSON.stringify({ stepMissed: true });
        } else if (quiet && !(still(from) && pause() && ours())) {
          // The user picked another record, or Music moved to other music while pausing.
          return JSON.stringify({ stepMissed: true });
        }
        // previousTrack restarts a record that's playing past its start, so rewind it first.
        // Every step re-checks the entry it starts from, since the user can pick another between them.
        for (let entry = from - 1; entry >= target; entry--) {
          if (!still(entry + 1)) return JSON.stringify({ stepMissed: true });
          Music.playerPosition = 0;
          // Previous only steps back once the rewind has landed; before that it restarts the record.
          // The entry is polled too, so a record the user picks meanwhile is neither stepped from nor paused.
          const rewound = until(function () { return !still(entry + 1) || Music.playerPosition() < 2; });
          if (!rewound || !still(entry + 1)) return JSON.stringify({ stepMissed: true });
          Music.previousTrack();
          if (!step(entry, entry + 1)) return JSON.stringify({ stepMissed: true });
        }
        for (let entry = from + 1; entry <= target; entry++) {
          if (!still(entry - 1)) return JSON.stringify({ stepMissed: true });
          Music.nextTrack();
          if (!step(entry, entry - 1)) return JSON.stringify({ stepMissed: true });
        }
        // Clamped inside the track, since Music.app ignores a position past the end.
        const goal = Math.min(args.position || 0, Math.max(0, Music.currentTrack.duration() - 1));
        if (!still(target)) return JSON.stringify({ stepMissed: true });
        Music.playerPosition = goal;
        // The entry is polled too, so a record the user picks while a long seek settles plays on.
        const sought = until(function () { return !still(target) || Math.abs(Music.playerPosition() - goal) < 2; });
        if (!sought || !still(target)) return JSON.stringify({ seekMissed: true });
        // From here Music should sit on the target, so cleanup can tell a record the user picked.
        reached = true;
        if (!inOrder()) return JSON.stringify({ orderDrifted: true });
        // Shuffle switched on while it stepped would carry on out of order; the finally pauses it.
        if (Music.shuffleEnabled()) return JSON.stringify({ shuffled: true });
        // Resumed only if Selecta paused it or it began paused; a pause the user made mid-route stands.
        if (quiet || (!restart && wasPaused)) {
          // The reads above take time too, so entry, order and shuffle are checked once more before playing.
          if (!still(target)) return JSON.stringify({ stepMissed: true });
          if (!inOrder()) return JSON.stringify({ orderDrifted: true });
          if (Music.shuffleEnabled()) return JSON.stringify({ shuffled: true });
          Music.play();
          if (!until(function () { return String(Music.playerState()) === 'playing'; })) {
            return JSON.stringify({ stillPaused: true });
          }
        }
        landed = true;
      } finally {
        // A start that went wrong is left paused, unless the user has moved Music elsewhere.
        if (!landed && reached) try { still(target); } catch (e) {}
        if (!landed && !picked && !pause()) return JSON.stringify({ leftPlaying: true });
      }
      return JSON.stringify({ playlistId: pl.persistentID(), route: route, player: readPlayer() });
    `,
  );
}
