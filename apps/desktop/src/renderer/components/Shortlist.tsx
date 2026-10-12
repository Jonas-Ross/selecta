// Replace, first look: the agent's picks in a popover over the record, each one
// open in turn with why it was picked, how it would join its neighbours, and
// ways to hear it before swapping it in.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Suggestion } from '../../shared/protocol.js';
import type { Rect } from '../flight.js';
import type { Replace } from '../hooks/useReplace.js';
import { useSettings } from '../hooks/useSettings.js';
import { auditionPlan, pickTrack, type Around } from '../replace.js';
import { Eq, Fit, PlayIcon, Steer, factsText } from './ReplaceParts.js';
import { Sleeve } from './Sleeve.js';

const WIDTH = 404;
// Room kept between the popover's arrow and the record, and around the window's edges.
const GAP = 14;
const EDGE = 12;
const SKELETONS = 4;

export function Shortlist({
  anchor,
  around,
  replace,
  agent,
  onSwap,
}: {
  anchor: () => Rect | undefined;
  around: Around;
  replace: Replace;
  agent: string;
  onSwap: (pick: Suggestion) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { joinLead } = useSettings().settings;
  const { state, heard, busy, trouble } = replace;
  const { prev, row, next } = around;
  const active = state?.active ?? state?.picks[0]?.track.persistent_id;

  // Above the record, arrow on its centre, kept inside the window.
  useLayoutEffect(() => {
    const place = () => {
      const node = box.current;
      const at = anchor();

      if (!node || !at) return;

      const centre = at.left + at.width / 2;
      const left = Math.max(EDGE, Math.min(innerWidth - WIDTH - EDGE, centre - WIDTH / 2));

      node.style.left = `${Math.round(left)}px`;
      node.style.bottom = `${Math.round(innerHeight - at.top + GAP)}px`;
      node.style.maxHeight = `${Math.round(Math.min(428, at.top - GAP - EDGE))}px`;
      node.style.setProperty('--arrow', `${Math.round(centre - left)}px`);
    };

    place();
    addEventListener('resize', place);

    return () => removeEventListener('resize', place);
  }, [anchor]);

  useEffect(() => box.current?.focus({ preventScroll: true }), []);

  if (!state) return null;

  const playing = (id: string) => heard?.state === 'playing' && heard.track_id === id;

  function key(e: React.KeyboardEvent) {
    const ids = state!.picks.map((pick) => pick.track.persistent_id);
    const dir = { ArrowDown: 1, ArrowUp: -1 }[e.key];

    if (dir === undefined || !ids.length || (e.target as HTMLElement).tagName === 'INPUT') return;

    e.preventDefault();
    replace.focus(ids[(ids.indexOf(active ?? '') + dir + ids.length) % ids.length]);
  }

  const sides = [
    prev && `after ${prev.title ?? 'Untitled'}`,
    next && `before ${next.title ?? 'Untitled'}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return createPortal(
    <div
      className="shortlist"
      role="dialog"
      aria-label={`Replace ${row.title ?? 'this record'}`}
      tabIndex={-1}
      ref={box}
      onKeyDown={key}
    >
      <div className="shortlist-head">
        <b>Instead of {row.title ?? 'Untitled'}</b>
        <span className="mono">{sides}</span>
      </div>
      <div className="shortlist-list" role="listbox" aria-label={`${agent}'s picks`}>
        {state.asking && (
          <p className="shortlist-status">
            <span className="dotp" />
            {agent} is looking through your library
          </p>
        )}
        {state.problem && (
          <p className="shortlist-status error">
            {state.problem}
            <button
              type="button"
              className="btn line sm"
              onClick={() => replace.open(state.entryId)}
            >
              Try again
            </button>
          </p>
        )}
        {state.picks.map((pick) => {
          const id = pick.track.persistent_id;
          const track = pickTrack(pick);
          const on = id === active;
          const hear = auditionPlan(around, track, 'hear', joinLead);
          const wayIn = auditionPlan(around, track, 'in', joinLead);

          return (
            <div
              key={id}
              className={on ? 'cand on' : 'cand'}
              role="option"
              aria-selected={on}
              onClick={() => replace.focus(id)}
            >
              <Sleeve trackId={id} title={track.title} />
              <div className="cand-t">
                <b>{track.title ?? 'Untitled'}</b>
                <span>{track.artist ?? 'Unknown artist'}</span>
              </div>
              <span className="cand-facts mono">
                {playing(id) && <Eq />}
                {factsText(track)}
              </span>
              {on && (
                <div className="cand-more">
                  {pick.reason && <p className="why">{pick.reason}</p>}
                  {(prev || next) && (
                    <dl className="fits">
                      {prev && (
                        <>
                          <dt>In</dt>
                          <dd>
                            <Fit from={prev} to={track} />
                          </dd>
                        </>
                      )}
                      {next && (
                        <>
                          <dt>Out</dt>
                          <dd>
                            <Fit from={track} to={next} />
                          </dd>
                        </>
                      )}
                    </dl>
                  )}
                  <div className="acts">
                    <button
                      type="button"
                      className="btn line sm"
                      disabled={busy || !hear}
                      onClick={() =>
                        playing(id) ? replace.pause() : hear && replace.audition(hear)
                      }
                    >
                      <PlayIcon playing={playing(id)} />
                      {playing(id) ? 'Pause' : 'Hear it'}
                    </button>
                    {prev && (
                      <button
                        type="button"
                        className="btn line sm"
                        disabled={busy || !wayIn}
                        title={`The end of ${prev.title ?? 'the record before'} blending into this`}
                        onClick={() => wayIn && replace.audition(wayIn)}
                      >
                        <PlayIcon />
                        Way in
                      </button>
                    )}
                    <span className="grow" />
                    <button
                      type="button"
                      className="btn line sm"
                      title="Both joins up close"
                      onClick={() => replace.view('bench', id)}
                    >
                      Close-up
                    </button>
                    <button type="button" className="btn uv sm" onClick={() => onSwap(pick)}>
                      Swap in
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {state.asking &&
          Array.from({ length: SKELETONS }, (_, i) => <div key={i} className="skel" />)}
      </div>
      <div className="shortlist-foot">
        {trouble && <p className="shortlist-trouble">Music.app: {trouble}</p>}
        <Steer agent={agent} hint="Ask for something else, like “more vocal”" onAsk={replace.ask} />
      </div>
    </div>,
    document.body,
  );
}
