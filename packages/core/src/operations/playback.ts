// Playback of a draft through the Selecta Preview playlist. Music.app plays it,
// so it moves through the set and AutoMix blends each join; this only starts,
// pauses and seeks it, and reads where it is.
import type { Draft, PreviewState } from '../drafts/contracts.js';
import type { DraftStore } from '../drafts/store.js';
import type { ToolDeps } from '../tools/deps.js';
import type { PlayerAction, PlayerEntry, PlayerState } from '../types/bridge.js';
import { BridgeError } from '../types/errors.js';
import { withOperation } from './lock.js';
import { PREVIEW_PLAYLIST_NAME } from './playlist.js';
import { syncDraftPreview } from './preview_playlist.js';

/**
 * Music.app's player as a draft sees it. `entry_id` is set only when Music.app
 * is playing this draft's preview in step with the draft, so a repeated track
 * still names the right record.
 */
export type PlaybackView = {
  running: boolean;
  state: 'playing' | 'paused' | 'stopped';
  track_id?: string;
  position?: number;
  duration?: number;
  entry_id?: string;
  // How a play reached the entry (started, on from N, back from N, seek), for an action log.
  route?: string;
};

export type PlaybackDeps = Pick<ToolDeps, 'bridge' | 'cache'> & { drafts: () => DraftStore };

/** The preview holds exactly this draft's order, so an index in it is an entry of the draft. */
export function inStep(draft: Draft, slot?: PreviewState): boolean {
  return (
    slot?.owner === draft.draft_id &&
    slot.status === 'current' &&
    JSON.stringify(slot.baseline) === JSON.stringify(draft.entries.map((entry) => entry.track_id))
  );
}

const AUDIBLE = new Set(['playing', 'fast forwarding', 'rewinding']);

/** What a screen shows: the entry playing only when Music.app is provably in this draft. */
export function playbackView(player: PlayerState, draft: Draft, slot?: PreviewState): PlaybackView {
  if (!player.running) return { running: false, state: 'stopped' };

  // Fast-forwarding and rewinding are audible, so the transport offers pause for them.
  const state =
    player.state === 'paused' ? 'paused' : AUDIBLE.has(player.state ?? '') ? 'playing' : 'stopped';
  const view: PlaybackView = {
    running: true,
    state,
    ...(player.track && {
      track_id: player.track.persistentId,
      duration: player.track.duration,
      position: player.position,
    }),
  };
  // By ID, not name: a copy of the preview playlist is not the slot this draft is in step with.
  const entry =
    slot?.playlist_id !== undefined &&
    player.playlist?.persistentId === slot.playlist_id &&
    player.index !== undefined &&
    inStep(draft, slot)
      ? draft.entries[player.index - 1]
      : undefined;

  if (entry && entry.track_id === player.track?.persistentId) view.entry_id = entry.entry_id;

  return view;
}

const UNKNOWN_PLAYER =
  "Music didn't say what it is playing, so the preview stayed linked. Try again.";

const entryOrder = (draft: Draft) => JSON.stringify(draft.entries.map((entry) => entry.entry_id));

export function createPlayback(deps: PlaybackDeps) {
  const { bridge, cache, drafts } = deps;
  // The preview this process last started as a queue. Music.app reads the same playing one
  // track alone, which carries on to nothing, so anything else is started over.
  let queued: string | undefined;
  // A playlist ID already found not to be this draft's slot, so a poll doesn't ask again.
  let unresolved: string | undefined;
  // The queued ID while Music plays a playlist of the reserved name under another, so a confirmed rekey keeps the queue.
  let rotatedFrom: string | undefined;
  const watch = (player: PlayerState) => {
    if (!player.running || player.state === 'stopped' || player.playlist?.persistentId !== queued) {
      rotatedFrom =
        player.running &&
        player.state !== 'stopped' &&
        player.playlist?.name === PREVIEW_PLAYLIST_NAME
          ? (queued ?? rotatedFrom)
          : undefined;
      queued = undefined;
    }

    return player;
  };
  const read = async () => watch(await bridge.readPlayer());

  // iCloud can rotate the slot's ID mid-session. A playlist of the reserved name is followed
  // only once the bridge confirms it is the only one and holds this draft's order.
  async function follow(draftId: string, player: PlayerState, locked: boolean) {
    const { draft, slot } = current(draftId);
    const playlist = player.running ? player.playlist : undefined;

    if (
      !slot ||
      !playlist ||
      playlist.name !== PREVIEW_PLAYLIST_NAME ||
      playlist.persistentId === slot.playlist_id ||
      playlist.persistentId === unresolved ||
      !inStep(draft, slot)
    )
      return;

    // The bridge's refusal is remembered too, so a poll never retries it every second; Play still rekeys.
    const resolve = async () => {
      const live = await bridge
        .readPreview({
          name: PREVIEW_PLAYLIST_NAME,
          expectedTrackIds: draft.entries.map((entry) => entry.track_id),
        })
        .catch(() => undefined);

      // Remembered before the rekey too, so a store that can't take it isn't retried every poll.
      unresolved = playlist.persistentId;

      if (live?.persistentId === playlist.persistentId) {
        drafts().rekeyPreview(draftId, slot.generation, live.persistentId);

        if (rotatedFrom === slot.playlist_id) queued = live.persistentId;
      }
    };

    // A busy lock never reached the bridge, so the next poll asks again.
    await (locked ? resolve() : withOperation(cache(), 'music', resolve)).catch(() => {});
  }

  const readFor = async (draftId: string, locked = false) => {
    const player = await read();

    await follow(draftId, player, locked);

    return player;
  };

  const current = (draftId: string) => {
    const store = drafts();

    return { draft: store.get(draftId), slot: store.preview() };
  };

  const show = (draftId: string, player: PlayerState) => {
    const { draft, slot } = current(draftId);

    return playbackView(player, draft, slot);
  };

  // The entry Music.app is on, read fresh, when it belongs to this draft; the bridge
  // re-checks it in the same call that acts, so a stale screen can't drive other music.
  // `owned` accepts any entry of the draft's own slot, in step or not, for stopping it.
  // iCloud can rotate the slot's ID after the last play rekeyed it, so a name match counts
  // only once the bridge finds it the only playlist of that name, holding the slot's order.
  const onThisDraft = async (draftId: string, owned = false) => {
    const player = await (owned ? read() : readFor(draftId, true));

    if (!player.running) return undefined;

    const { playlist, track, index } = player;

    if (!playlist || !track || index === undefined) {
      // A read that lost what's playing can't prove the preview is silent, so a stop fails closed.
      if (owned && player.state !== 'stopped') throw new Error(UNKNOWN_PLAYER);

      return undefined;
    }

    const { slot } = current(draftId);
    const rotated =
      owned &&
      slot?.owner === draftId &&
      slot.baseline !== undefined &&
      playlist.persistentId !== slot.playlist_id &&
      playlist.name === PREVIEW_PLAYLIST_NAME &&
      (await bridge
        .readPreview({ name: PREVIEW_PLAYLIST_NAME, expectedTrackIds: slot.baseline })
        .then(
          (live) => live.persistentId === playlist.persistentId,
          () => false,
        ));
    const ours = owned
      ? slot?.owner === draftId && (playlist.persistentId === slot.playlist_id || rotated)
      : show(draftId, player).entry_id !== undefined;

    if (!ours) return undefined;

    return {
      playlistId: playlist.persistentId,
      index,
      trackId: track.persistentId,
      ...(rotated && { slot: PREVIEW_PLAYLIST_NAME }),
    };
  };

  return {
    state: async (draftId: string) => show(draftId, await readFor(draftId)),

    async play(
      draftId: string,
      revision: number,
      entryId: string,
      position?: number,
    ): Promise<PlaybackView> {
      let { draft, slot } = current(draftId);

      if (draft.revision !== revision)
        throw new Error('The draft changed since you pressed play. Try again.');

      const find = () => draft.entries.findIndex((entry) => entry.entry_id === entryId);
      let index = find();

      if (index < 0) throw new Error('That record is no longer in the draft.');

      // Loading the draft into the preview is the write the user chose to listen for.
      if (!inStep(draft, slot)) {
        // A queue Music.app took from the old contents is not this draft's.
        queued = undefined;

        const { preview_result: result } = await syncDraftPreview(drafts(), deps, draft, true);

        if (result?.error) throw new Error([result.error, result.hint].filter(Boolean).join(': '));

        ({ draft, slot } = current(draftId));

        if (!inStep(draft, slot))
          throw new Error(
            'Selecta Preview did not end up in the draft order, so nothing was played.',
          );

        // An edit can move or drop repeated records during the sync without changing the track order.
        index = find();

        if (index < 0) throw new Error('That record is no longer in the draft.');
      }

      // A metadata edit moves the revision but not what Music plays, so the guards below compare order.
      const order = entryOrder(draft);
      const sameOrder = (now: Draft) => entryOrder(now) === order;

      // A failed read surfaces rather than restarting Music on a guess.
      await read();

      const played = await withOperation(cache(), 'music', async () => {
        // Another front end may have detached or taken the slot while this waited; the
        // playlist would still pass the bridge's order check, so ownership is read again here.
        const now = current(draftId);

        if (!sameOrder(now.draft) || !inStep(now.draft, now.slot))
          throw new Error(
            'Selecta Preview changed hands before it could play, so nothing was played.',
          );

        const trackIds = now.draft.entries.map((entry) => entry.track_id);
        const result = await bridge.playPreview({
          expectedTrackIds: trackIds,
          index,
          ...(position !== undefined && { position }),
          ...(queued === undefined && { restart: true }),
        });

        // An edit from another front end can land while Music steps; its sync then waits on
        // this lock, so Music would play an order the draft no longer has.
        const after = current(draftId);

        if (!sameOrder(after.draft) || !inStep(after.draft, after.slot)) {
          const paused = await pauseAfter(result.playlistId, result.player, trackIds);

          throw new Error(
            paused
              ? 'The draft changed while Music started it, so Music was paused. Play again.'
              : 'The draft changed while Music started it, and Music could not be paused. Pause it in Music, then play again.',
          );
        }

        // The play resolved the slot by name and order, so its live ID is the slot's now.
        // Music is already playing, so a store that can't take the new ID pauses it before failing.
        if (now.slot && result.playlistId !== now.slot.playlist_id) {
          try {
            drafts().rekeyPreview(draftId, now.slot.generation, result.playlistId);
          } catch (error) {
            const paused = await pauseAfter(result.playlistId, result.player, trackIds);
            const reason = error instanceof Error ? error.message : String(error);

            throw new Error(
              paused
                ? `Music started but Selecta could not record the preview (${reason}), so Music was paused.`
                : `Music started but Selecta could not record the preview (${reason}), and Music could not be paused. Pause it in Music.`,
            );
          }
        }

        return result;
      });

      queued = played.playlistId;

      return { ...show(draftId, played.player), ...(played.route && { route: played.route }) };
    },

    // Under the music lock, so a control can't interleave with a preview sync's rewrite.
    control: (draftId: string, input: PlayerAction) =>
      withOperation(cache(), 'music', async () => {
        const on = await onThisDraft(draftId);

        if (!on) throw new Error("Music isn't playing this draft, so nothing was changed.");

        const { draft } = current(draftId);
        const expectedTrackIds =
          input.action === 'resume' ? draft.entries.map((entry) => entry.track_id) : undefined;
        const player = watch(
          await bridge.controlPlayer({
            ...input,
            on,
            ...(expectedTrackIds && { expectedTrackIds }),
          }),
        );

        // As with play, an edit from another front end can land during the resume and wait on this lock.
        if (expectedTrackIds) {
          const after = current(draftId);

          if (entryOrder(after.draft) !== entryOrder(draft) || !inStep(after.draft, after.slot)) {
            const paused = await pauseAfter(on.playlistId, player, expectedTrackIds);

            throw new Error(
              paused
                ? 'The draft changed while Music resumed it, so Music was paused. Play again.'
                : 'The draft changed while Music resumed it, and Music could not be paused. Pause it in Music, then play again.',
            );
          }
        }

        return show(draftId, player);
      }),

    // Releases the link so Claude can edit again; Music.app keeps the playlist as it is.
    // Pauses first only if Music is playing this draft, never something the user moved on to.
    detach: (draftId: string, revision: number) =>
      withOperation(cache(), 'music', async () => {
        await pauseOwn(() => onThisDraft(draftId, true), current(draftId).slot?.baseline);
        drafts().detachPreview(draftId, revision);
      }),
  };

  // Pauses what an action just left playing, naming the reported entry first and then re-reading,
  // following a rotated ID by name for the bridge to confirm it is the only such playlist.
  async function pauseAfter(playlistId: string, started: PlayerState, order: string[]) {
    let first = true;

    return pauseOwn(async () => {
      const live = first ? started : await read();

      first = false;

      if (!live.running || live.state === 'stopped') return undefined;

      if (!live.track || live.index === undefined || !live.playlist)
        throw new Error(UNKNOWN_PLAYER);

      const rotated =
        live.playlist.persistentId !== playlistId && live.playlist.name === PREVIEW_PLAYLIST_NAME;

      return live.playlist.persistentId === playlistId || rotated
        ? {
            playlistId: live.playlist.persistentId,
            index: live.index,
            trackId: live.track.persistentId,
            ...(rotated && { slot: PREVIEW_PLAYLIST_NAME }),
          }
        : undefined;
    }, order).then(
      () => true,
      () => false,
    );
  }

  // A conflict means Music moved between the read and the pause; the preview may only
  // have advanced to its next record, so it reads again rather than assume it's gone.
  // `order` is the playlist's track IDs, which tell an advance from a rewrite.
  async function pauseOwn(locate: () => ReturnType<typeof onThisDraft>, order?: string[]) {
    let missed: { on: PlayerEntry; error: BridgeError } | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      const on = await locate();

      if (!on) return;

      // Only the same record, or the one after it in order, is Music carrying on by itself; any
      // other entry was picked or rewritten, so the conflict stands rather than pausing it.
      if (
        missed &&
        !(on.index === missed.on.index && on.trackId === missed.on.trackId) &&
        !(on.index === missed.on.index + 1 && on.trackId === order?.[missed.on.index])
      )
        throw missed.error;

      const after = await bridge.controlPlayer({ action: 'pause', on }).catch((e: unknown) => {
        if (!(e instanceof BridgeError && e.errorCode === 'preview_conflict')) throw e;

        missed = { on, error: e };
      });

      if (!after) continue;

      // Resumed in Music during the pause's settle, rekeyed by iCloud, or playing somewhere the
      // read lost: it may still be ours and audible, so stay linked.
      if (
        after.running &&
        after.state !== 'paused' &&
        after.state !== 'stopped' &&
        (!after.playlist ||
          after.playlist.persistentId === on.playlistId ||
          after.playlist.name === PREVIEW_PLAYLIST_NAME)
      )
        throw new Error('Music is still playing the preview, so it stayed linked. Try again.');

      return;
    }

    throw new Error('Music kept moving within the preview, so it stayed linked. Try again.');
  }
}

export type Playback = ReturnType<typeof createPlayback>;
