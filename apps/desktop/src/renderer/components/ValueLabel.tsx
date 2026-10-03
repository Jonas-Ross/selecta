// A tempo or key printed on its lane segment; hover says where it came from.
import { keyFacts, tempoFacts } from '../facts.js';
import type { Row } from '../state.js';
import { useExplain } from './Explain.js';

export function ValueLabel({
  kind,
  row,
  x,
  y,
  hot,
}: {
  kind: 'tempo' | 'key';
  row: Row;
  x: number;
  y: number;
  hot: boolean;
}) {
  const tempo = kind === 'tempo';
  const text = tempo ? String(Math.round(row.bpm!)) : row.camelot!;
  const provisional = (tempo ? row.bpm_maturity : row.key_maturity) === 'provisional';
  const explain = useExplain(() => ({
    title: tempo ? `Tempo · ${text} BPM` : `Key · ${row.musical_key ?? text} · ${text}`,
    side: row.title,
    body: (
      <dl>
        {(tempo ? tempoFacts(row) : keyFacts(row)).map((fact) => (
          <div key={fact.label} className="tip-row">
            <dt>{fact.label}</dt>
            <dd>{fact.text}</dd>
          </div>
        ))}
      </dl>
    ),
  }));

  return (
    <span
      className={`value${hot ? ' hot' : ''}${provisional ? ' provisional' : ''}`}
      style={{ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)` }}
      {...explain}
    >
      {text}
    </span>
  );
}
