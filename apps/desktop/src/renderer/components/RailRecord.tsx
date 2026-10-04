// One record standing on the rail: sleeve, remove button and caption, posed by
// its springs. Pointer and key handling come from the rail.
import type { Anim } from '../hooks/useRailSprings.js';
import { slotX, type Shelf } from '../lanes.js';
import { Sleeve } from './Sleeve.js';

export type RailRecordProps = {
  anim: Anim;
  index: number;
  count: number;
  step: number;
  shelf: Shelf;
  reduced: boolean;
  locked: boolean;
  selected: boolean;
  /** How far the record in hand rides above or below the rail; set only on that record. */
  heldDy?: number;
  setNode: (node: HTMLDivElement | null) => void;
  onPress: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onRelease: (e: React.PointerEvent<HTMLElement>, cancelled: boolean) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
  onRemove: () => void;
};

export function RailRecord({
  anim,
  index,
  count,
  step,
  shelf,
  reduced,
  locked,
  selected,
  heldDy,
  setNode,
  onPress,
  onPointerMove,
  onRelease,
  onKeyDown,
  onFocus,
  onBlur,
  onRemove,
}: RailRecordProps) {
  const { row, pos, lift, squash, grow, leaving } = anim;
  const isHeld = heldDy !== undefined;
  const x = slotX(pos.x, step) + shelf.gap / 2;
  // Tops lag the push: the record in hand leans further than ones it shoves along.
  const lean = isHeld ? 2.4 : 1.4;
  const tilt = reduced ? 0 : Math.max(-8, Math.min(8, -pos.v * lean));
  const sq = squash.x;
  const label = [
    `${index + 1} of ${count}: ${row.title ?? row.track_id} by ${row.artist ?? 'unknown'}`,
    row.bpm === undefined ? 'tempo not measured' : `${Math.round(row.bpm)} BPM`,
    row.camelot ?? 'key not measured',
    ...(selected ? ['selected for feedback'] : []),
  ].join(', ');

  return (
    <div
      ref={setNode}
      className={`rec${selected ? ' sel' : ''}${isHeld ? ' held' : ''}${leaving ? ' leaving' : ''}`}
      role="listitem"
      tabIndex={leaving ? -1 : 0}
      aria-label={`${label}. Enter selects${locked ? '' : ', Alt and arrow keys move it, Delete removes it'}.`}
      style={{
        width: shelf.size,
        height: shelf.size,
        transform: `translate3d(${x.toFixed(1)}px, ${(shelf.rail - shelf.size + (heldDy ?? 0)).toFixed(1)}px, 0)`,
        zIndex: isHeld || lift.x > 0.02 ? 5 : undefined,
      }}
      onPointerDown={(e) => !leaving && onPress(e)}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => onRelease(e, false)}
      onPointerCancel={(e) => onRelease(e, true)}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div
        className="rec-body"
        style={{
          transform: `translateY(${(reduced ? 0 : -14 * lift.x).toFixed(2)}px) rotate(${tilt.toFixed(2)}deg) scale(${((1 + 0.06 * lift.x) * grow.x).toFixed(4)}) scale(${(1 + 0.03 * sq).toFixed(4)}, ${(1 - 0.07 * sq).toFixed(4)})`,
          opacity: Math.min(1, grow.x * 1.4),
        }}
      >
        <Sleeve trackId={row.track_id} title={row.title} />
      </div>
      {!locked && !leaving && (
        <button
          type="button"
          className="rec-x"
          tabIndex={-1}
          disabled={count === 1}
          aria-label={`Remove ${row.title ?? 'track'}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
          </svg>
        </button>
      )}
      {/* Lifted records leave their caption behind; it returns as they land. */}
      <div
        className="cap"
        style={{
          width: shelf.size + shelf.gap - 10,
          top: shelf.size + 10,
          opacity: Math.min(1, grow.x) * (1 - lift.x),
        }}
      >
        <span className="cap-title">{row.title ?? row.track_id}</span>
        <span className="cap-artist">{row.artist ?? 'Unknown artist'}</span>
      </div>
    </div>
  );
}
