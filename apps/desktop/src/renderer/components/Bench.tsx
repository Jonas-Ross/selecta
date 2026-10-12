// Replace, close up: the band above the rail becomes a bench of the record
// before, the way in, the candidate, the way out and the record after, with
// the picks along the bottom to try in turn.
import type { Suggestion } from '../../shared/protocol.js';
import type { Replace } from '../hooks/useReplace.js';
import { join } from '../joins.js';
import { auditionPlan, pickTrack, type Around, type Listening } from '../replace.js';
import type { Track } from '../state.js';
import { Term } from './Explain.js';
import { Glyph } from './JoinMarker.js';
import { PlayIcon, Steer, factsText } from './ReplaceParts.js';
import { Sleeve } from './Sleeve.js';

const SKELETONS = 4;

type Candidate = Track & { track_id: string };

function Neighbour({ track, edge }: { track?: Candidate; edge: string }) {
  return (
    <div className="nb">
      {track ? (
        <>
          <Sleeve trackId={track.track_id} title={track.title} />
          <b>{track.title ?? 'Untitled'}</b>
          <span className="mono">{factsText(track)}</span>
        </>
      ) : (
        <span className="mono">{edge}</span>
      )}
    </div>
  );
}

function JoinCard({
  from,
  to,
  side,
  disabled,
  onListen,
}: {
  from?: Track;
  to?: Track;
  side: 'in' | 'out';
  disabled: boolean;
  onListen: () => void;
}) {
  const label = side === 'in' ? 'Way in' : 'Way out';

  if (!from || !to)
    return (
      <div className={`jcard ${side}`}>
        <span className="lbl mono">{label}</span>
        <span className="kw">{side === 'in' ? 'Opens the set' : 'Closes the set'}</span>
      </div>
    );

  const facts = join(from, to);

  return (
    <div className={`jcard ${side}`}>
      <span className="lbl mono">
        <Term name="join">{label}</Term>
      </span>
      <div className="jline">
        <Glyph from={facts.from} to={facts.to} />
        <div>
          <div className="tstep">{facts.tempo}</div>
          <div className="kw">{facts.words}</div>
        </div>
      </div>
      <span className="vals mono">
        {factsText(from)} → {factsText(to)}
      </span>
      <button type="button" className="btn line sm" disabled={disabled} onClick={onListen}>
        <PlayIcon />
        Hear the way {side}
      </button>
    </div>
  );
}

export function Bench({
  around,
  replace,
  agent,
  onSwap,
}: {
  around: Around;
  replace: Replace;
  agent: string;
  onSwap: (pick: Suggestion) => void;
}) {
  const { state, heard, busy, trouble } = replace;

  if (!state) return null;

  const { prev, row, next } = around;
  const pick = state.picks.find((p) => p.track.persistent_id === state.active);
  const shown: Candidate = pick ? pickTrack(pick) : row;
  const playing = heard?.state === 'playing' && heard.track_id === shown.track_id;

  const listen = (listening: Listening) => {
    const plan = auditionPlan(around, shown, listening);

    if (plan) replace.audition(plan);
  };

  return (
    <section className="bench" role="dialog" aria-label={`Replace ${row.title ?? 'this record'}`}>
      <div className="bench-row">
        <Neighbour track={prev} edge="Start of the set" />
        <JoinCard
          from={prev}
          to={shown}
          side="in"
          disabled={busy || !auditionPlan(around, shown, 'in')}
          onListen={() => listen('in')}
        />
        <div className="bench-mid">
          <div className="bench-big">
            <Sleeve trackId={shown.track_id} title={shown.title} />
            <button
              type="button"
              className={playing ? 'play-o on' : 'play-o'}
              disabled={busy}
              aria-label={`${playing ? 'Pause' : 'Hear'} ${shown.title ?? 'this record'}`}
              onClick={() => (playing ? replace.pause() : listen('hear'))}
            >
              <PlayIcon playing={playing} />
            </button>
          </div>
          <h4>{shown.title ?? 'Untitled'}</h4>
          <span className="by">
            {shown.artist ?? 'Unknown artist'} · <span className="mono">{factsText(shown)}</span>
          </span>
          <p className="why">
            {pick
              ? pick.reason
              : state.asking
                ? `${agent} is looking through your library`
                : 'In the draft now.'}
          </p>
        </div>
        <JoinCard
          from={shown}
          to={next}
          side="out"
          disabled={busy || !auditionPlan(around, shown, 'out')}
          onListen={() => listen('out')}
        />
        <Neighbour track={next} edge="End of the set" />
      </div>
      <div className="bench-foot">
        <div className="picks" role="listbox" aria-label={`${agent}'s picks`}>
          <button
            type="button"
            role="option"
            aria-selected={!pick}
            aria-label={`${row.title ?? 'Untitled'}, in the draft now`}
            className={pick ? 'pick' : 'pick on'}
            onClick={() => replace.focus(undefined)}
          >
            <Sleeve trackId={row.track_id} title={row.title} />
            <span className="tag mono">now</span>
          </button>
          {state.picks.map((p) => {
            const track = pickTrack(p);

            return (
              <button
                key={track.track_id}
                type="button"
                role="option"
                aria-selected={p === pick}
                aria-label={`${track.title ?? 'Untitled'}, ${factsText(track)}`}
                title={`${track.title ?? 'Untitled'} · ${factsText(track)}`}
                className={p === pick ? 'pick on' : 'pick'}
                onClick={() => replace.focus(track.track_id)}
              >
                <Sleeve trackId={track.track_id} title={track.title} />
              </button>
            );
          })}
          {state.asking &&
            Array.from({ length: SKELETONS }, (_, i) => <span key={i} className="pick skel" />)}
          {state.problem && <span className="bench-problem">{state.problem}</span>}
        </div>
        {trouble && <span className="bench-problem">Music.app: {trouble}</span>}
        <Steer agent={agent} hint="Ask for something else" onAsk={replace.ask} />
        <button type="button" className="btn line sm" onClick={() => replace.view('list')}>
          Back to list
        </button>
        <button
          type="button"
          className="btn uv sm"
          disabled={!pick}
          onClick={() => pick && onSwap(pick)}
        >
          Swap in
        </button>
      </div>
    </section>
  );
}
