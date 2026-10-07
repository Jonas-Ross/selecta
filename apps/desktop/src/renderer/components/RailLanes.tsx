// What the rail draws around its records: the lane titles and axis in the
// gutter, and, across the scrolling content, the tempo and key lanes, each
// slot's labels, the joins between records and the gap held for one arriving.
import {
  formatClock,
  keyY,
  labelFade,
  slotX,
  startTimes,
  stepPath,
  tempoY,
  type Box,
  type BpmScale,
  type Shelf,
} from '../lanes.js';
import type { Row } from '../state.js';
import { Term } from './Explain.js';
import { JoinMarker } from './JoinMarker.js';
import { ValueLabel } from './ValueLabel.js';

export function RailGutter({ shelf, scale }: { shelf: Shelf; scale: BpmScale }) {
  const { bands } = shelf;

  return (
    <div className="gutter">
      <span className="lane-title" style={{ top: shelf.tempo.top - 22 }}>
        <Term name="bpm">Tempo</Term> <span className="unit">BPM</span>
      </span>
      {scale.labels.map((value) => (
        <span
          key={value}
          className="axis"
          // The lowest number rides up off the Time title rather than sitting on it.
          style={{ top: Math.min(tempoY(value, scale, shelf.tempo) - 6, shelf.tick - 14) }}
        >
          {value}
        </span>
      ))}
      <span className="lane-title" style={{ top: shelf.tick - 1 }}>
        <Term name="time">Time</Term>
      </span>
      <span className="lane-title" style={{ top: shelf.join + 2 }}>
        <Term name="join">Joins</Term>
      </span>
      <span className="lane-title" style={{ top: shelf.key.top - 22 }}>
        <Term name="key">Key</Term> <Term name="camelot">Camelot</Term>
      </span>
      <span className="band" style={{ top: bands.B.top + bands.B.height / 2 - 7 }}>
        <Term name="major">B</Term>
      </span>
      <span className="band" style={{ top: bands.A.top + bands.A.height / 2 - 7 }}>
        <Term name="minor">A</Term>
      </span>
    </div>
  );
}

export type RailLanesProps = {
  /** The records on the rail in the order they stand this frame, at their slot position. */
  standing: { id: string; row: Row; pos: number }[];
  shelf: Shelf;
  scale: BpmScale;
  step: number;
  width: number;
  height: number;
  /** The visible stretch of the content, in content pixels. */
  scrolled: number;
  view: number;
  held?: string;
  landed?: { id: string; at: number };
  hole?: number;
};

export function RailLanes({
  standing,
  shelf,
  scale,
  step,
  width,
  height,
  scrolled,
  view,
  held,
  landed,
  hole,
}: RailLanesProps) {
  const slots = standing.map(({ id, row, pos }) => ({
    id,
    row,
    x0: slotX(pos, step),
    tempo: row.bpm === undefined ? undefined : tempoY(row.bpm, scale, shelf.tempo),
    key: keyY(row.camelot, shelf.bands),
  }));
  const path = (y: 'tempo' | 'key') =>
    stepPath(
      slots.map((slot) => ({ x0: slot.x0, x1: slot.x0 + step, y: slot[y], hot: slot.id === held })),
    );
  const tempo = path('tempo');
  const keys = path('key');
  const starts = startTimes(slots.map((slot) => slot.row.duration_seconds));
  const { bands } = shelf;
  // Labels and joins are drawn only near the visible stretch; a long draft has hundreds.
  const near = (x: number) => x > scrolled - step * 2 && x < scrolled + view + step;

  let grid = '';

  for (const value of scale.grid)
    grid += `M0 ${tempoY(value, scale, shelf.tempo).toFixed(1)}H${width}`;

  for (const band of [bands.B, bands.A])
    if (band.height > 36)
      for (let n = 1; n < 12; n++)
        grid += `M0 ${(band.top + (n * band.height) / 12).toFixed(1)}H${width}`;

  let seams = '';

  for (const { x0 } of slots.slice(1))
    seams += `M${x0.toFixed(1)} ${shelf.tempo.top}v${shelf.tempo.height}M${x0.toFixed(1)} ${shelf.key.top}v${shelf.key.height}`;

  const missing = (x0: number, lane: Box) =>
    step > 84 && (
      <span
        className="missing"
        style={{ transform: `translate(${x0 + step / 2}px, ${lane.top + lane.height / 2 - 7}px)` }}
      >
        <Term name="missing">not measured</Term>
      </span>
    );

  return (
    <>
      <svg className="lanes" width={width} height={height} aria-hidden="true">
        <defs>
          <pattern
            id="hatch"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line className="hatch" x1="0" y1="0" x2="0" y2="6" />
          </pattern>
        </defs>
        <path className="lane-grid" d={grid || 'M0 0'} />
        {[shelf.tempo, bands.B, bands.A].map((lane, i) => (
          <rect
            key={i}
            className="lane-box"
            x="0"
            y={lane.top}
            width={width}
            height={lane.height}
          />
        ))}
        <path className="lane-seams" d={seams || 'M0 0'} />
        {[
          { lane: shelf.tempo, gaps: tempo.gaps },
          { lane: shelf.key, gaps: keys.gaps },
        ].flatMap(({ lane, gaps }, i) =>
          gaps.map((gap, k) => (
            <rect
              key={`${i}-${k}`}
              className="gap"
              x={gap.x0 + 1}
              y={lane.top}
              width={Math.max(0, gap.x1 - gap.x0 - 2)}
              height={lane.height}
            />
          )),
        )}
        <path className="step" d={tempo.d + keys.d || 'M0 0'} />
        <path className="step-hot" d={tempo.hot + keys.hot || 'M0 0'} />
        <path className="step-caps" d={tempo.caps + keys.caps || 'M0 0'} />
      </svg>

      {slots.map(
        (slot, k) =>
          near(slot.x0) && (
            <div key={slot.id} className="slot-labels">
              <span
                className="tick"
                style={{ transform: `translate(${slot.x0 + 4}px, ${shelf.tick}px)` }}
              >
                {formatClock(starts[k]!.seconds)}
                {starts[k]!.partial ? '+' : ''}
              </span>
              {slot.tempo === undefined ? (
                missing(slot.x0, shelf.tempo)
              ) : (
                <ValueLabel
                  kind="tempo"
                  row={slot.row}
                  x={slot.x0 + 6}
                  y={slot.tempo - 16}
                  hot={slot.id === held}
                />
              )}
              {slot.key === undefined ? (
                missing(slot.x0, shelf.key)
              ) : (
                <ValueLabel
                  kind="key"
                  row={slot.row}
                  x={slot.x0 + 6}
                  y={slot.key - 16}
                  hot={slot.id === held}
                />
              )}
            </div>
          ),
      )}

      {slots.slice(1).map((slot, k) => {
        const prev = slots[k]!;
        // A join's room is the narrower slot beside it; squeezed joins drop their words first.
        const room = Math.min(slot.x0 - prev.x0, (slots[k + 2]?.x0 ?? slot.x0 + step) - slot.x0);

        return (
          near(slot.x0) && (
            <JoinMarker
              key={`${prev.id}|${slot.id}`}
              from={prev.row}
              to={slot.row}
              position={k + 1}
              x={slot.x0}
              rail={shelf.rail}
              y={shelf.join}
              width={step - 8}
              hot={held === slot.id || held === prev.id}
              words={labelFade(room, step * 0.85, step * 0.1)}
              tempo={labelFade(room, 72, 20)}
              flashAt={
                landed && (landed.id === slot.id || landed.id === prev.id) ? landed.at : undefined
              }
            />
          )
        );
      })}

      {hole !== undefined && (
        <div
          className="drop-slot"
          style={{
            width: shelf.size,
            height: shelf.size,
            transform: `translate3d(${slotX(hole, step) + shelf.gap / 2}px, ${shelf.rail - shelf.size}px, 0)`,
          }}
        >
          <span className="mono">drops here</span>
        </div>
      )}
    </>
  );
}
