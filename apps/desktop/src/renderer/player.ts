// The Listen screen's view of Music.app. It reads the player about once a
// second while Listen is open, the draft is linked or it is playing, and stops reading
// after a failure until the user acts, so a denied permission isn't hit every second.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerView } from '../shared/protocol.js';
import { selecta } from './api.js';

const READ_EVERY_MS = 1000;

/** `looking` is Listen open or the draft linked; a draft playing keeps the bar live anywhere. */
export function usePlayer(draftId: string, looking: boolean) {
  const [view, setView] = useState<PlayerView>();
  const [readAt, setReadAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  // Bumped by every action, so a read started before it can't land after it.
  const epoch = useRef(0);

  const accept = useCallback((next: PlayerView) => {
    setView(next);
    setReadAt(performance.now());
  }, []);

  const watching = looking || (view?.state === 'playing' && view.entry_id !== undefined);

  useEffect(() => {
    if (!watching || problem) return;

    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    const read = () => {
      const at = epoch.current;

      selecta
        .call('player.state', { draft_id: draftId })
        .then(
          (next) => alive && at === epoch.current && accept(next),
          (e: Error) => alive && at === epoch.current && setProblem(e.message),
        )
        .finally(() => {
          if (alive) timer = setTimeout(read, READ_EVERY_MS);
        });
    };

    read();

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [draftId, watching, problem, accept]);

  const act = (call: Promise<PlayerView | void>) => {
    epoch.current++;
    setBusy(true);
    setProblem(undefined);

    return call
      .then((next) => {
        if (next) accept(next);
      })
      .catch((e: Error) => setProblem(e.message))
      .finally(() => setBusy(false));
  };

  return {
    view,
    readAt,
    busy,
    problem,
    dismiss: () => setProblem(undefined),
    play: (revision: number, entryId: string, position?: number) =>
      act(
        selecta.call('player.play', {
          draft_id: draftId,
          revision,
          entry_id: entryId,
          ...(position !== undefined && { position }),
        }),
      ),
    pause: () => act(selecta.call('player.pause', { draft_id: draftId })),
    resume: () => act(selecta.call('player.resume', { draft_id: draftId })),
    seek: (position: number) => act(selecta.call('player.seek', { draft_id: draftId, position })),
    // The host pauses Music first if it's on this draft, then releases the preview.
    detach: (revision: number) =>
      act(
        selecta
          .call('player.detach', { draft_id: draftId, revision })
          .then(() => selecta.call('player.state', { draft_id: draftId })),
      ),
  };
}

export type Player = ReturnType<typeof usePlayer>;
