// The card beside the crate: what is known about the record in front, with
// where each measurement came from. Missing values say so; nothing is guessed.
import type { Crate } from '../../shared/protocol.js';
import { formatClock } from '../lanes.js';
import { FeatureFacts } from './FeatureFacts.js';

type CrateTrack = Crate['tracks'][number];

export function Spec({
  track,
  pulled,
  inDraft,
  canAdd,
  lockedReason,
  onAdd,
  onPull,
}: {
  track: CrateTrack;
  pulled: boolean;
  inDraft: boolean;
  canAdd: boolean;
  lockedReason?: string;
  onAdd: () => void;
  onPull: () => void;
}) {
  const { signal } = track;

  return (
    <div className="spec" key={track.persistent_id}>
      <div className="spec-kicker">
        <span>{pulled ? 'Pulled out' : 'In front'}</span>
        {inDraft ? (
          <span className="in">In the draft</span>
        ) : (
          track.genre && <span>{track.genre}</span>
        )}
      </div>
      <h3 className="spec-title">{track.title ?? 'Untitled'}</h3>
      <p className="spec-artist">
        {[track.artist ?? 'Unknown artist', track.album].filter(Boolean).join(' · ')}
      </p>
      <dl className="facts">
        <FeatureFacts track={track} />
        <div className="fact">
          <dt>Plays</dt>
          <dd>
            {signal.play_count} play{signal.play_count === 1 ? '' : 's'} · {signal.skip_count} skip
            {signal.skip_count === 1 ? '' : 's'}
            {signal.loved ? ' · loved' : ''}
          </dd>
        </div>
        <div className="fact">
          <dt>Length</dt>
          <dd>
            {[
              track.duration_seconds === undefined
                ? 'unknown'
                : formatClock(track.duration_seconds),
              track.year,
            ]
              .filter((part) => part !== undefined)
              .join(' · ')}
          </dd>
        </div>
      </dl>
      <div className="spec-actions">
        <button
          type="button"
          className="btn primary"
          disabled={!canAdd}
          title={canAdd ? undefined : lockedReason}
          onClick={onAdd}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M6 1.5v9M1.5 6h9" />
          </svg>
          Add to draft
        </button>
        <button type="button" className="btn line" onClick={onPull}>
          {pulled ? (
            'Put back'
          ) : (
            <>
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M6 10.5v-9M2 5.5l4-4 4 4" />
              </svg>
              Pull out
            </>
          )}
        </button>
      </div>
    </div>
  );
}
