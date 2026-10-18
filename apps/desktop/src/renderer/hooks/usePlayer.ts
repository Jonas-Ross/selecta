// The Listen screen's view of Music.app. It reads the player about once a
// second while Listen is open, the draft is linked or it is playing, and stops reading
// after a failure until the user acts, so a denied permission isn't hit every second.
// An action shows what it asked for at once, marked pending, until the host answers.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerView } from '../../shared/protocol.js';
import { selecta } from '../api.js';
import { asked } from '../listen.js';

const READ_EVERY_MS = 1000;

export function usePlayer(draftId: string, looking: boolean) {
  const [shown, setShown] = useState<{ view?: PlayerView; readAt: number }>({ readAt: 0 });
  const [problem, setProblem] = useState<string>();
  // Calls not yet answered; while any are, the screen shows what was asked rather than a read.
  const outstanding = useRef(0);
  // The host's newest answer while later calls are still out, shown once they all land.
  const answered = useRef<PlayerView>(undefined);
  // Bumped by every action, so a read started before it can't land after it.
  const epoch = useRef(0);
  const current = useRef(shown);

  current.current = shown;

  const accept = useCallback((view: PlayerView) => {
    setShown({ view, readAt: performance.now() });
  }, []);

  const { view } = shown;
  const watching = looking || (view?.state === 'playing' && view.entry_id !== undefined);

  useEffect(() => {
    if (!watching || problem) return;

    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    const read = () => {
      const at = epoch.current;
      const fresh = () => alive && at === epoch.current && outstanding.current === 0;

      selecta
        .call('player.state', { draft_id: draftId })
        .then(
          (next) => fresh() && accept(next),
          (e: Error) => fresh() && setProblem(e.message),
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

  /** Shows `ask` applied to what's shown now, then the host's answer once every call has landed. */
  const act = (
    ask: (now: { view?: PlayerView; readAt: number }) => PlayerView | undefined,
    call: () => Promise<unknown>,
  ) => {
    epoch.current++;
    outstanding.current++;
    setProblem(undefined);

    const wanted = ask(current.current);

    // Kept in the ref too, so a second click before the next render builds on this one.
    if (wanted) {
      current.current = { view: { ...wanted, pending: true }, readAt: performance.now() };
      setShown(current.current);
    }

    return call()
      .then((next) => {
        if (next) answered.current = next as PlayerView;
      })
      .catch((e: Error) => {
        // A failure leaves Music wherever it got to, which only a fresh read can say.
        answered.current = undefined;
        setProblem(e.message);
      })
      .finally(() => {
        if (--outstanding.current > 0) return;

        epoch.current++;

        const answer = answered.current;

        answered.current = undefined;

        if (answer) return accept(answer);

        // Nothing said what Music is doing now, so it's read rather than taken from what was asked.
        const at = epoch.current;

        selecta.call('player.state', { draft_id: draftId }).then(
          (next) => at === epoch.current && outstanding.current === 0 && accept(next),
          (e: Error) => at === epoch.current && setProblem(e.message),
        );
      });
  };

  return {
    view,
    readAt: shown.readAt,
    /** Some call is still waiting on Music. */
    pending: view?.pending === true,
    problem,
    dismiss: () => setProblem(undefined),
    act,
    pause: () =>
      act(
        (now) => asked.pause(now.view, now.readAt, performance.now()),
        () => selecta.call('player.pause', { draft_id: draftId }),
      ),
    resume: () =>
      act(
        (now) => asked.resume(now.view),
        () => selecta.call('player.resume', { draft_id: draftId }),
      ),
    seek: (position: number) =>
      act(
        (now) => asked.seek(now.view, position),
        () => selecta.call('player.seek', { draft_id: draftId, position }),
      ),
  };
}

export type Player = ReturnType<typeof usePlayer>;
