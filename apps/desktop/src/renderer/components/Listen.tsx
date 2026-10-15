// Listen, in the crate's place above the rail: the record playing, large, and
// the sleeve back beside it: its facts and the transition into the next record.
import type { CSSProperties } from 'react';
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
  status,
  joinDisabled,
  onJoin,
}: {
  items: Row[];
  now: number;
  playing: boolean;
  // Music.app is on this record, playing or paused, rather than it being only cued.
  current: boolean;
  status?: string;
  joinDisabled: boolean;
  onJoin: () => void;
}) {
  const { joinLead } = useSettings().settings;
  const row = items[now];
  const next = items[now + 1];
  const palette = usePalette(row?.track_id);
  const still = useReducedMotion();

  if (!row)
    return (
      <section className="deck deck-empty" aria-label="Listen">
        <p>Nothing to play yet.</p>
      </section>
    );

  const j = next && join(row, next);

  return (
    <section
      className={`deck${playing && row.bpm && !still ? ' breathing' : ''}`}
      aria-label="Listen"
    >
      <i
        className={`deck-glow${palette ? ' on' : ''}`}
        aria-hidden="true"
        style={
          {
            background: palette?.a,
            // Swells once a bar, four beats, at the record's measured tempo.
            '--bar': row.bpm ? `${240 / row.bpm}s` : undefined,
          } as CSSProperties
        }
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
