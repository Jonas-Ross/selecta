// Listen, in the crate's place above the rail: the record playing, large, and
// the sleeve back beside it: its facts and the transition into the next record.
import { useEffect, useRef, type RefObject } from 'react';
import { join } from '../joins.js';
import { useReducedMotion } from '../hooks/motion.js';
import { useSettings } from '../hooks/useSettings.js';
import { usePalette } from '../palette.js';
import type { Row } from '../state.js';
import { Term } from './Explain.js';
import { FeatureFacts } from './FeatureFacts.js';
import { Sleeve } from './Sleeve.js';

export function Listen({
  items,
  now,
  playing,
  current,
  position,
  status,
  joinDisabled,
  onJoin,
}: {
  items: Row[];
  now: number;
  playing: boolean;
  // Music.app is on this record, playing or paused, rather than it being only cued.
  current: boolean;
  /** Seconds into the record Music is on. */
  position: number;
  status?: string;
  joinDisabled: boolean;
  onJoin: () => void;
}) {
  const { joinLead } = useSettings().settings;
  const row = items[now];
  const next = items[now + 1];
  const palette = usePalette(row?.track_id);
  const still = useReducedMotion();
  const glow = useRef<HTMLElement>(null);

  usePulse(glow, playing && !still && row?.bpm ? 240 / row.bpm : undefined, position);

  if (!row)
    return (
      <section className="deck deck-empty" aria-label="Listen">
        <p>Nothing to play yet.</p>
      </section>
    );

  const j = next && join(row, next);

  return (
    <section className="deck" aria-label="Listen">
      <i
        ref={glow}
        className={`deck-glow${palette ? ' on' : ''}`}
        aria-hidden="true"
        style={{ background: palette?.a }}
      />
      <div className={`deck-hero${playing ? ' playing' : ''}`}>
        <div className="deck-record" key={row.entry_id}>
          <Sleeve trackId={row.track_id} title={row.title} />
        </div>
        <div className="deck-title">
          <span className="deck-kicker mono">
            {current ? (playing ? 'Now playing' : 'Paused') : 'Cued'} · record {now + 1} of{' '}
            {items.length}
          </span>
          <h2>{row.title ?? 'Untitled'}</h2>
          <p>{row.artist ?? 'Unknown artist'}</p>
          {status && <p className="deck-status mono">{status}</p>}
        </div>
      </div>
      <aside className="sleeve-back" aria-label="Sleeve back">
        <dl className="facts">
          <FeatureFacts track={row} trackId={row.track_id} />
        </dl>
        <span className="ls-lab">Up next</span>
        {next && j ? (
          <>
            <div className="next">
              <Sleeve trackId={next.track_id} title={next.title} />
              <div>
                <b>{next.title ?? 'Untitled'}</b>
                <span>{next.artist ?? 'Unknown artist'}</span>
              </div>
            </div>
            <dl className="joinbox">
              <dt>
                <Term name="join">Transition</Term>
              </dt>
              <dd>{j.tempo}</dd>
              <dt>
                <Term name="key">Key</Term>
              </dt>
              <dd>
                {j.words}
                {j.from && j.to && (
                  <span className="mono">
                    {' '}
                    {j.from} → {j.to}
                  </span>
                )}
                {j.provisional && (
                  <Term name="provisional">
                    <span className="prov">provisional</span>
                  </Term>
                )}
              </dd>
            </dl>
            <div className="hj">
              <button type="button" className="btn uv" disabled={joinDisabled} onClick={onJoin}>
                Hear the transition
              </button>
              <p>Plays the last {joinLead} seconds of this track into the next.</p>
            </div>
          </>
        ) : (
          <p className="last">Last track in the draft.</p>
        )}
      </aside>
    </section>
  );
}

// Bars are counted from the start of the record by Music's position, so the swell pauses
// and seeks with it. Where the first beat really falls isn't known: the app can't hear Music.
function usePulse(el: RefObject<HTMLElement | null>, bar: number | undefined, position: number) {
  const pulse = useRef<Animation>(undefined);

  useEffect(() => {
    if (!bar) return;

    pulse.current = el.current!.animate(
      [
        { transform: 'scale(1)' },
        { transform: 'scale(1.08)', offset: 0.04 },
        { transform: 'scale(1)', offset: 0.6 },
        { transform: 'scale(1)' },
      ],
      { duration: bar * 1000, iterations: Infinity, easing: 'ease-out' },
    );

    return () => {
      pulse.current?.cancel();
      pulse.current = undefined;
    };
  }, [el, bar]);

  useEffect(() => {
    const animation = pulse.current;

    if (!animation) return;

    const start = document.timeline.currentTime;

    if (typeof start !== 'number') return;

    const origin = start - position * 1000;

    // Music is read about once a second, so only a real jump moves the bar line.
    if (animation.startTime === null || Math.abs(Number(animation.startTime) - origin) > 120)
      animation.startTime = origin;
  }, [position, bar]);
}
