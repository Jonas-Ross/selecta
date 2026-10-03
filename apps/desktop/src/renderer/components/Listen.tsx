// Listen, in the crate's place above the rail: the record playing, large, with
// its disc out and turning while Music.app plays it, and the sleeve back
// beside it: its facts, the join into the next record, and the set's route
// round the key wheel.
import { join } from '../joins.js';
import { JOIN_LEAD } from '../listen.js';
import type { Row } from '../state.js';
import { Term } from './Explain.js';
import { FeatureFacts } from './FeatureFacts.js';
import { KeyWheel } from './KeyWheel.js';
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
  status: string;
  joinDisabled: boolean;
  onJoin: () => void;
}) {
  const row = items[now];
  const next = items[now + 1];

  if (!row)
    return (
      <section className="deck deck-empty" aria-label="Listen">
        <p>Nothing to play until the draft has records.</p>
      </section>
    );

  const j = next && join(row, next);

  return (
    <section className="deck" aria-label="Listen">
      <div className={`deck-hero${playing ? ' spinning' : ''}${current ? ' out' : ''}`}>
        <div className="deck-record" key={row.entry_id}>
          <div className="deck-disc" aria-hidden="true">
            <i className="deck-label" />
          </div>
          <div className="deck-sleeve">
            <Sleeve trackId={row.track_id} title={row.title} />
          </div>
        </div>
        <div className="deck-title">
          <span className="deck-kicker mono">
            {current ? (playing ? 'Now playing' : 'Paused') : 'Cued'} · record {now + 1} of{' '}
            {items.length}
          </span>
          <h2>{row.title ?? 'Untitled'}</h2>
          <p>{row.artist ?? 'Unknown artist'}</p>
          <p className="deck-status mono">{status}</p>
        </div>
      </div>
      <aside className="sleeve-back" aria-label="Sleeve back">
        <dl className="facts">
          <FeatureFacts track={row} />
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
                <Term name="join">The join</Term>
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
                Hear the join
              </button>
              <p>
                Plays through Music.app from {JOIN_LEAD} s before the end of{' '}
                {row.title ?? 'this record'}, and <Term name="automix">AutoMix</Term> blends it into{' '}
                {next.title ?? 'the next'}.
              </p>
            </div>
          </>
        ) : (
          <p className="last">
            {row.title ?? 'This record'} closes the draft, so there is no join.
          </p>
        )}
        <KeyWheel items={items} now={now} />
      </aside>
    </section>
  );
}
