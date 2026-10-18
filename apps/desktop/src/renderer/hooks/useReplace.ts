// Replacing one record: asking the agent for stand-ins, auditioning them through
// Selecta Preview, and closing up. The swap itself is the draft's edit to make.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditionView, ProviderId, Suggestion } from '../../shared/protocol.js';
import { selecta } from '../api.js';
import { poll, stopAfter, type AuditionPlan } from '../replace.js';

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
  // The newest audition call, or 0 once it has landed; the host folds waiting calls together.
  const outstanding = useRef(0);
  const [trouble, setTrouble] = useState<string>();
  // Bumped by every ask and close, so a late answer never lands on a newer one.
  const asked = useRef(0);
  // Set once an audition has written Selecta Preview, so closing knows to pause it.
  const auditioned = useRef(false);
  // The audition or pause still under way, which holds Music until it lands.
  const inFlight = useRef<Promise<unknown>>(undefined);
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
      void stopAfter(inFlight.current, () => selecta.call('player.auditionStop')).catch(
        (e: Error) => warn(e.message),
      );

    auditioned.current = false;
    inFlight.current = undefined;
    setPolling(false);
    setHeard(undefined);
  }, [draftId, warn]);

  // Leaving the draft leaves Music where it was, minus the audition.
  useEffect(() => close, [close]);

  // Music.app is read about once a second while an audition may be playing. A failed read is
  // said and stops the poll; the next audition starts it again.
  useEffect(() => {
    if (!polling) return;

    return poll(
      () => selecta.call('player.auditionState'),
      READ_EVERY_MS,
      (next) => outstanding.current === 0 && setHeard(next),
      (e) => {
        setTrouble(e.message);
        setPolling(false);
      },
    );
  }, [polling]);

  function track<T>(call: Promise<T>) {
    inFlight.current = call;

    return call;
  }

  // `wanted` shows at once; the newest answer replaces it once every call has landed.
  function act(wanted: AuditionView, call: () => Promise<AuditionView | void>) {
    const mine = ++outstanding.current;

    setTrouble(undefined);
    setHeard(wanted);
    call()
      .then((next) => outstanding.current === mine && setHeard(next ?? { state: 'stopped' }))
      .catch((e: Error) => {
        setTrouble(e.message);

        // What Music did instead is the next read's to say.
        if (outstanding.current === mine) setHeard(undefined);
      })
      .finally(() => {
        if (outstanding.current === mine) outstanding.current = 0;
      });
  }

  return {
    state,
    heard,
    trouble,
    open: (entryId: string) => ask(entryId),
    ask: (text: string) => state && ask(state.entryId, text),
    close,
    focus: (trackId?: string) => setState((s) => s && { ...s, active: trackId }),
    view: (view: Replacing['view'], trackId?: string) =>
      setState(
        (s) => s && { ...s, view, active: trackId ?? s.active ?? s.picks[0]?.track.persistent_id },
      ),
    audition: (plan: AuditionPlan) => {
      auditioned.current = true;
      setPolling(true);
      act(
        {
          state: 'playing',
          track_id: plan.track_ids[plan.index],
          index: plan.index,
          ...(plan.position !== undefined && { position: plan.position }),
          pending: true,
        },
        () => track(selecta.call('player.audition', plan)),
      );
    },
    pause: () =>
      act({ ...heard, state: 'stopped', pending: true }, () =>
        track(selecta.call('player.auditionStop')),
      ),
  };
}

export type Replace = ReturnType<typeof useReplace>;
