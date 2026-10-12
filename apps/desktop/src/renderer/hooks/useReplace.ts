// Replacing one record: asking the agent for stand-ins, auditioning them through
// Selecta Preview, and closing up. The swap itself is the draft's edit to make.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditionView, ProviderId, Suggestion } from '../../shared/protocol.js';
import { selecta } from '../api.js';
import { stopAfter, type AuditionPlan } from '../replace.js';

const READ_EVERY_MS = 1000;

export type Replacing = {
  entryId: string;
  view: 'list' | 'bench';
  asking: boolean;
  picks: Suggestion[];
  /** The pick in focus by track ID; on the bench, none is the record in the draft now. */
  active?: string;
  problem?: string;
  /** Every pick offered so far, so asking again brings new ones. */
  shown: string[];
};

export function useReplace(
  draftId: string,
  provider: () => ProviderId | undefined,
  // Closing outlives the shortlist, so a pause that fails is said where the draft shows notices.
  warn: (message: string) => void,
) {
  const [state, setState] = useState<Replacing>();
  const [heard, setHeard] = useState<AuditionView>();
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string>();
  // Bumped by every ask and close, so a late answer never lands on a newer one.
  const asked = useRef(0);
  // Set once an audition has written Selecta Preview, so closing knows to pause it.
  const auditioned = useRef(false);
  // The audition still starting, which holds Music until it lands.
  const starting = useRef<Promise<unknown>>(undefined);
  const [polling, setPolling] = useState(false);
  const current = useRef(state);

  current.current = state;

  function ask(entryId: string, text?: string) {
    const mine = ++asked.current;
    const prev = current.current?.entryId === entryId ? current.current : undefined;
    const shown = [
      ...new Set([
        ...(prev?.shown ?? []),
        ...(prev?.picks ?? []).map((p) => p.track.persistent_id),
      ]),
    ];

    setState({ entryId, view: prev?.view ?? 'list', asking: true, picks: [], shown });
    selecta
      .call('agent.suggest', {
        draft_id: draftId,
        entry_id: entryId,
        ...(text && { ask: text }),
        exclude: shown,
        provider: provider(),
      })
      .then(
        (picks) =>
          asked.current === mine &&
          setState(
            (s) => s && { ...s, asking: false, picks, active: picks[0]?.track.persistent_id },
          ),
        (e: Error) =>
          asked.current === mine &&
          setState((s) => s && { ...s, asking: false, problem: e.message }),
      );
  }

  const close = useCallback(() => {
    asked.current++;

    if (current.current?.asking)
      void selecta.call('agent.stopSuggest', { draft_id: draftId }).catch(() => undefined);

    setState(undefined);
    setTrouble(undefined);

    if (auditioned.current)
      void stopAfter(starting.current, () => selecta.call('player.auditionStop')).catch(
        (e: Error) => warn(e.message),
      );

    auditioned.current = false;
    starting.current = undefined;
    setPolling(false);
    setHeard(undefined);
  }, [draftId, warn]);

  // Leaving the draft leaves Music where it was, minus the audition.
  useEffect(() => close, [close]);

  // Music.app is read about once a second while an audition may be playing.
  useEffect(() => {
    if (!polling) return;

    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    const read = () => {
      void selecta
        .call('player.auditionState')
        .then((next) => alive && setHeard(next))
        .catch(() => undefined)
        .finally(() => {
          if (alive) timer = setTimeout(read, READ_EVERY_MS);
        });
    };

    timer = setTimeout(read, READ_EVERY_MS);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [polling]);

  function act(call: () => Promise<AuditionView | void>) {
    if (busy) return;

    setBusy(true);
    setTrouble(undefined);
    call()
      .then((next) => setHeard(next ?? { state: 'stopped' }))
      .catch((e: Error) => setTrouble(e.message))
      .finally(() => setBusy(false));
  }

  return {
    state,
    heard,
    busy,
    trouble,
    open: (entryId: string) => ask(entryId),
    ask: (text: string) => state && ask(state.entryId, text),
    close,
    focus: (trackId?: string) => setState((s) => s && { ...s, active: trackId }),
    view: (view: Replacing['view'], trackId?: string) =>
      setState(
        (s) => s && { ...s, view, active: trackId ?? s.active ?? s.picks[0]?.track.persistent_id },
      ),
    audition: (plan: AuditionPlan) =>
      act(() => {
        auditioned.current = true;
        setPolling(true);

        const call = selecta.call('player.audition', plan);

        starting.current = call;

        return call;
      }),
    pause: () => act(() => selecta.call('player.auditionStop')),
  };
}

export type Replace = ReturnType<typeof useReplace>;
