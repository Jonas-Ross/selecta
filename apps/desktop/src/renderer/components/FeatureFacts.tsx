// Tempo and key as fact rows, each with where it came from and how sure that
// was. Shared by the crate's spec card and Listen's sleeve back.
import { keyFacts, sourceShort, tempoFacts } from '../facts.js';
import type { Track } from '../state.js';
import { Term, useExplain } from './Explain.js';

function Source({ kind, track }: { kind: 'tempo' | 'key'; track: Track }) {
  const tempo = kind === 'tempo';
  const explain = useExplain(() => ({
    title: tempo ? 'Where this tempo came from' : 'Where this key came from',
    side: track.title,
    body: (
      <dl>
        {(tempo ? tempoFacts(track) : keyFacts(track)).map((fact) => (
          <div key={fact.label} className="tip-row">
            <dt>{fact.label}</dt>
            <dd>{fact.text}</dd>
          </div>
        ))}
      </dl>
    ),
  }));

  const confidence = tempo ? track.bpm_confidence : track.key_confidence;

  return (
    <button type="button" className="term" {...explain}>
      {sourceShort(tempo ? track.bpm_source : track.key_source)}
      {confidence !== undefined && ` · ${confidence.toFixed(2)}`}
    </button>
  );
}

export function FeatureFacts({ track }: { track: Track }) {
  const camelot = track.camelot;

  return (
    <>
      <div className="fact">
        <dt>
          <Term name="bpm">Tempo</Term>
        </dt>
        {track.bpm === undefined ? (
          <dd>
            <Term name="missing">
              <span className="miss">Not measured</span>
            </Term>
          </dd>
        ) : (
          <>
            <dd>
              <span className="num">{Math.round(track.bpm)}</span>
              <span className="unit">BPM</span>
            </dd>
            <div className="meta">
              <Source kind="tempo" track={track} />
            </div>
          </>
        )}
      </div>
      <div className="fact">
        <dt>
          <Term name="key">Key</Term>
        </dt>
        {track.musical_key === undefined ? (
          <dd>
            <Term name="missing">
              <span className="miss">Not measured</span>
            </Term>
          </dd>
        ) : (
          <>
            <dd>
              <span className="word">{track.musical_key}</span>
              {camelot && <Term name="camelot">{camelot}</Term>}
              {track.key_maturity === 'provisional' && (
                <Term name="provisional">
                  <span className="prov">provisional</span>
                </Term>
              )}
            </dd>
            <div className="meta">
              <Source kind="key" track={track} />
            </div>
          </>
        )}
      </div>
    </>
  );
}
