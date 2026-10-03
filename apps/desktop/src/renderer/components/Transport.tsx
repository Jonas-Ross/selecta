// The player bar under the draft: previous, play and next, the record playing,
// a scrubber, and where the set is in time. Music.app is the clock; the bar
// fills in between its reads.
import { useState } from 'react';
import { formatClock } from '../lanes.js';
import type { Row } from '../state.js';
import { Sleeve } from './Sleeve.js';

export function Transport({
  row,
  index,
  count,
  playing,
  position,
  duration,
  set,
  disabled,
  canPrev,
  canNext,
  onToggle,
  onPrev,
  onNext,
  onSeek,
  onOpen,
  onStop,
  stopDisabled = false,
}: {
  row?: Row;
  index: number;
  count: number;
  playing: boolean;
  position: number;
  duration?: number;
  set: { elapsed: number; partial: boolean; total: number; totalPartial: boolean };
  disabled: boolean;
  canPrev: boolean;
  canNext: boolean;
  onToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek?: (position: number) => void;
  onOpen?: () => void;
  // Set while the draft is linked to the preview: pauses and releases it so Claude can edit again.
  onStop?: () => void;
  stopDisabled?: boolean;
}) {
  const length = duration ?? row?.duration_seconds;
  // Held while dragging, so Music.app gets one seek on release rather than one per pixel.
  const [scrubbing, setScrubbing] = useState<number>();
  const shown = scrubbing ?? position;
  const commit = () => {
    if (scrubbing !== undefined) onSeek?.(scrubbing);

    setScrubbing(undefined);
  };

  return (
    <footer className="transport" aria-label="Playback">
      <div className="tp-btns">
        <button
          type="button"
          className="ib"
          aria-label="Previous record"
          disabled={disabled || !canPrev}
          onClick={onPrev}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 2h1.6v10H3zM12 2v10L5.4 7z" />
          </svg>
        </button>
        <button
          type="button"
          className={`ib play${playing ? ' on' : ''}`}
          aria-label={playing ? 'Pause' : 'Play'}
          disabled={disabled || !row}
          onClick={onToggle}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            {playing ? <path d="M3 2h3v10H3zM8 2h3v10H8z" /> : <path d="M3.5 1.8v10.4L12.3 7z" />}
          </svg>
        </button>
        {/* Always drawn, so the bar never shifts as busy or linked state comes and goes. */}
        <button
          type="button"
          className="ib"
          aria-label="Stop listening and release Selecta Preview"
          title="Stop listening"
          disabled={!onStop || stopDisabled}
          onClick={onStop}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 3h8v8H3z" />
          </svg>
        </button>
        <button
          type="button"
          className="ib"
          aria-label="Next record"
          disabled={disabled || !canNext}
          onClick={onNext}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M9.4 2H11v10H9.4zM2 2v10l6.6-5z" />
          </svg>
        </button>
      </div>
      <button
        type="button"
        className="tp-now"
        onClick={onOpen}
        disabled={!onOpen || !row}
        aria-label="Open Listen"
      >
        {row && <Sleeve trackId={row.track_id} title={row.title} />}
        <span>
          <b>{row?.title ?? 'Nothing cued'}</b>
          <span>{row?.artist ?? ''}</span>
        </span>
      </button>
      <div className="tp-scrub">
        <span className="mono">{formatClock(shown)}</span>
        <input
          className="scrub"
          type="range"
          min={0}
          max={Math.max(1, Math.round(length ?? 1))}
          step={1}
          value={Math.round(shown)}
          disabled={disabled || !onSeek || length === undefined}
          aria-label="Position in track"
          aria-valuetext={`${formatClock(shown)} of ${length === undefined ? 'unknown' : formatClock(length)}`}
          onChange={(e) => setScrubbing(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={() => setScrubbing(undefined)}
        />
        <span className="mono">{length === undefined ? '–:––' : formatClock(length)}</span>
      </div>
      <div className="tp-set mono">
        <b>
          {count ? index + 1 : 0}/{count}
        </b>
        <span>
          {formatClock(set.elapsed)}
          {set.partial ? '+' : ''} of {formatClock(set.total)}
          {set.totalPartial ? '+' : ''}
        </span>
      </div>
    </footer>
  );
}
