// Playback for the Listen screen. Music.app plays the draft from the Selecta
// Preview playlist, so it moves through the set and AutoMix blends each join;
// the app only starts, pauses and seeks it, and reads where it is.
import type { Bridge, PlayerState } from '@selecta/core/types/bridge.js';
import type { Draft, PreviewState } from '@selecta/core/drafts/contracts.js';
import type { DraftStore } from '@selecta/core/drafts/store.js';
import type { SelectaCache } from '@selecta/core/cache/index.js';
import { withOperation } from '@selecta/core/operations/lock.js';
import { PREVIEW_PLAYLIST_NAME } from '@selecta/core/operations/playlist.js';
import { BridgeError } from '@selecta/core/types/errors.js';
import type { PlayerView } from '../shared/protocol.js';

type Envelope = {
  error?: string;
  hint?: string;
  preview?: PreviewState;
  preview_result?: { error?: string; hint?: string };
};

type Control = { action: 'pause' } | { action: 'resume' } | { action: 'seek'; position: number };

export type PlayerDeps = {
  bridge: Bridge;
  cache: () => SelectaCache;
  drafts: () => DraftStore;
  // The same preview operation the MCP tool runs, guards and receipts included.
  preview: (args: {
    draft_id: string;
    revision: number;
    mode: 'start' | 'detach';
  }) => Promise<Envelope>;
};

/** The preview holds exactly this draft's order, so an index in it is an entry of the draft. */
export function inStep(draft: Draft, slot?: PreviewState): boolean {
  return (
    slot?.owner === draft.draft_id &&
    slot.status === 'current' &&
    JSON.stringify(slot.baseline) === JSON.stringify(draft.entries.map((entry) => entry.track_id))
  );
}

/** What the screen shows: the entry playing only when Music.app is provably in this draft. */
export function playerView(player: PlayerState, draft: Draft, slot?: PreviewState): PlayerView {
  if (!player.running) return { running: false, state: 'stopped' };

  const state = player.state === 'playing' || player.state === 'paused' ? player.state : 'stopped';
  const view: PlayerView = {
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

function failure(response: Envelope): Error | undefined {
  const problem = response.error
    ? response
    : response.preview_result?.error
      ? response.preview_result
      : undefined;

  return problem && new Error([problem.error, problem.hint].filter(Boolean).join(': '));
}

export function createPlayer({ bridge, cache, drafts, preview }: PlayerDeps) {
  // The preview this process last started as a queue. Music.app reads the same playing one
  // track alone, which carries on to nothing, so anything else is started over.
  let queued: string | undefined;
  const watch = (player: PlayerState) => {
    if (!player.running || player.state === 'stopped' || player.playlist?.persistentId !== queued)
      queued = undefined;

    return player;
  };
  const read = async () => watch(await bridge.readPlayer());

  const current = (draftId: string) => {
    const store = drafts();

    return { draft: store.get(draftId), slot: store.preview() };
  };

  const show = (draftId: string, player: PlayerState) => {
    const { draft, slot } = current(draftId);

    return playerView(player, draft, slot);
  };

  // The entry Music.app is on, read fresh, when it belongs to this draft; the bridge
  // re-checks it in the same call that acts, so a stale screen can't drive other music.
  // `owned` accepts any entry of the draft's own slot, in step or not, for stopping it.
  // iCloud can rotate the slot's ID after the last play rekeyed it, so a name match is
  // passed on for the bridge to confirm it is the only playlist of that name.
  const onThisDraft = async (draftId: string, owned = false) => {
    const player = await read();

    if (!player.running) return undefined;

    const { playlist, track, index } = player;

    if (!playlist || !track || index === undefined) return undefined;

    const { slot } = current(draftId);
    const rotated =
      owned &&
      slot?.owner === draftId &&
      playlist.persistentId !== slot.playlist_id &&
      playlist.name === PREVIEW_PLAYLIST_NAME;
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
    state: async (draftId: string) => show(draftId, await read()),

    async play(draftId: string, revision: number, entryId: string, position?: number) {
      let { draft, slot } = current(draftId);

      if (draft.revision !== revision)
        throw new Error('The draft changed since you pressed play. Try again.');

      const index = draft.entries.findIndex((entry) => entry.entry_id === entryId);

      if (index < 0) throw new Error('That record is no longer in the draft.');

      // Loading the draft into the preview is the write the user chose Listen for.
      if (!inStep(draft, slot)) {
        // A queue Music.app took from the old contents is not this draft's.
        queued = undefined;

        const started = await preview({ draft_id: draftId, revision, mode: 'start' });
        const problem = failure(started);

        if (problem) throw problem;

        ({ draft, slot } = current(draftId));

        if (!inStep(draft, slot))
          throw new Error(
            'Selecta Preview did not end up in the draft order, so nothing was played.',
          );
      }

      // A failed read only means the queue can't be vouched for; the play itself still runs.
      await read().catch(() => (queued = undefined));

      const played = await withOperation(cache(), 'music', () =>
        bridge.playPreview({
          expectedTrackIds: draft.entries.map((entry) => entry.track_id),
          index,
          ...(position !== undefined && { position }),
          ...(queued === undefined && { restart: true }),
        }),
      );

      queued = played.playlistId;

      // The play resolved the slot by name and order, so its live ID is the slot's now.
      if (slot && played.playlistId !== slot.playlist_id)
        drafts().rekeyPreview(draftId, slot.generation, played.playlistId);

      return { ...show(draftId, played.player), ...(played.route && { route: played.route }) };
    },

    // Under the music lock, so a control can't interleave with a preview sync's rewrite.
    control: (draftId: string, input: Control) =>
      withOperation(cache(), 'music', async () => {
        const on = await onThisDraft(draftId);

        if (!on) throw new Error("Music isn't playing this draft, so nothing was changed.");

        return show(draftId, watch(await bridge.controlPlayer({ ...input, on })));
      }),

    // Releases the link so Claude can edit again; Music.app keeps the playlist as it is.
    // Pauses first only if Music is playing this draft, never something the user moved on to.
    async detach(draftId: string, revision: number) {
      // Music moving off the draft between the read and the pause leaves nothing to pause.
      await withOperation(cache(), 'music', async () => {
        const on = await onThisDraft(draftId, true);

        if (!on) return;

        const after = await bridge.controlPlayer({ action: 'pause', on }).catch((e: unknown) => {
          if (!(e instanceof BridgeError && e.errorCode === 'preview_conflict')) throw e;
        });

        // Resumed in Music during the pause's settle: still ours and audible, so stay linked.
        if (
          after?.running &&
          after.state === 'playing' &&
          after.playlist?.persistentId === on.playlistId
        )
          throw new Error('Music is still playing the preview, so it stayed linked. Try again.');
      });

      const response = await preview({ draft_id: draftId, revision, mode: 'detach' });
      const problem = failure(response);

      if (problem) throw problem;
    },
  };
}

export type Player = ReturnType<typeof createPlayer>;
