// What stands in for a blank tempo or key: a button that measures the track
// from its store preview, then either the value (once the view re-reads) or why not.
import { missWords } from '../facts.js';
import { measureTrack, useMeasure } from '../hooks/useMeasure.js';
import { useExplain } from './Explain.js';

export function Measure({
  trackId,
  kind,
  title,
}: {
  trackId: string;
  kind: 'tempo' | 'key';
  title?: string;
}) {
  const state = useMeasure(trackId);
  const reason = state?.phase === 'done' ? state.result[kind] : undefined;
  const words =
    reason && missWords(reason, state?.phase === 'done' ? state.result.error : undefined);
  const explain = useExplain(() =>
    words
      ? { title: 'Still not measured', side: title, body: <p>{words.text}</p> }
      : {
          title: 'Not measured',
          side: title,
          body: <p>Measure listens to its 30 s store preview for the tempo and key.</p>,
        },
  );

  // Done with nothing to say means a value landed; it shows once the view re-reads.
  if (state?.phase === 'measuring' || (state?.phase === 'done' && !reason))
    return (
      <span className="measure busy" role="status">
        measuring
      </span>
    );

  if (words && reason !== 'failed')
    return (
      <button type="button" className="term measure-miss" {...explain}>
        {words.label}
      </button>
    );

  return (
    <button
      type="button"
      className="measure"
      aria-label={`Measure ${title ?? 'this track'}`}
      onClick={() => measureTrack(trackId)}
      {...explain}
    >
      {words ? 'retry' : 'measure'}
    </button>
  );
}
