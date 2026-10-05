// The crate: the library as records standing in a bin, flipped through by
// scroll, drag or arrow keys (`useCrateFlip`). The record in front can be
// pulled out to read, added to the draft, or carried onto the rail by hand.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { selecta } from '../api.js';
import { backZ, counterText, frontZ, pose, visibleRange } from '../crate.js';
import type { Rect } from '../flight.js';
import { useReducedMotion } from '../hooks/motion.js';
import { useCrateFlip } from '../hooks/useCrateFlip.js';
import type { Crate as CrateData, CrateTrack } from '../../shared/protocol.js';
import { Flight } from './Flight.js';
import { Sleeve } from './Sleeve.js';
import { Spec } from './Spec.js';

export type { CrateTrack };

// Sleeve tops seen from above: graphite, a few cooler and lighter.
const EDGES = [
  '#2b3142',
  '#1a1d25',
  '#3b4356',
  '#23272f',
  '#454e63',
  '#1f2430',
  '#30364a',
  '#272b35',
];
const SEARCH_DELAY = 160;

const edgeOf = (id: string) =>
  EDGES[[...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % EDGES.length];

export type CrateProps = {
  inDraft: Set<string>;
  canAdd: boolean;
  lockedReason?: string;
  /** Adds a record; `at` is the rail slot it was dropped on, else the end. */
  onAdd: (track: CrateTrack, from: Rect, at?: number) => void;
  /** Where on the rail a carried record would land, and how big records stand there. */
  onCarry: (x: number, y: number) => { at: number; size: number } | undefined;
  onCarryEnd: () => void;
};

export function Crate({ inDraft, canAdd, lockedReason, onAdd, onCarry, onCarryEnd }: CrateProps) {
  const reduced = useReducedMotion();
  const stage = useRef<HTMLDivElement>(null);
  const faces = useRef(new Map<string, HTMLElement>());
  const [size, setSize] = useState(0);
  const [query, setQuery] = useState('');
  const [data, setData] = useState<CrateData & { query: string }>();
  const [error, setError] = useState<string>();
  const flip = useCrateFlip({
    data,
    size,
    reduced,
    stage,
    faces,
    canAdd,
    onAdd,
    onCarry,
    onCarryEnd,
  });
  const { motions, cur, front, pulledId, carrying, returning } = flip;
  const count = data?.tracks.length ?? 0;

  useLayoutEffect(() => {
    const node = stage.current!;
    // Sleeves fill most of the stage's height; the rest is the bin's front and air.
    const measure = () =>
      setSize(Math.round(Math.max(140, Math.min(256, node.clientHeight * 0.56))));
    const observer = new ResizeObserver(measure);

    measure();
    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  // The newest search wins; one typed while another is in flight never shows stale records.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(
      () =>
        selecta.call('library.crate', query.trim() ? { query } : {}).then(
          (next) => live && (setData({ ...next, query }), setError(undefined)),
          (e: Error) => live && setError(e.message),
        ),
      data ? SEARCH_DELAY : 0,
    );

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  const c = flip.crate;
  const pos = c.pos.x;
  const lean = reduced ? 0 : Math.max(-16, Math.min(16, -c.pos.v * 4.5)) + c.wobble.x;
  const frontMotion = front && motions.get(front.persistent_id);
  const frontLift = frontMotion
    ? { lift: frontMotion.lift.x * size * 0.07, pulled: frontMotion.pulled.x }
    : undefined;
  const [lo, hi] = visibleRange(pos, count);
  const drawn = [...motions.entries()].filter(
    ([, m]) => m.slot.x >= lo - 1 && m.slot.x < hi && !(m.leaving && m.out.x > 0.98),
  );
  const W = size * 1.1;
  const fz = frontZ(size);
  const depth = fz - backZ(size);
  const isPulled = pulledId !== undefined && pulledId === front?.persistent_id;
  const label = data?.query.trim() ? `Matching “${data.query.trim()}”` : 'Recently added';

  return (
    <section className="dig" aria-label="The crate">
      <div className="dig-head">
        <h2 className="h-label">
          The crate<span>your library</span>
        </h2>
        <label className="search">
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <circle cx="5" cy="5" r="3.8" />
            <path d="M8 8l3 3" />
          </svg>
          <span className="sr">Search the crate</span>
          <input
            type="search"
            placeholder="Title, artist, album, genre"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'ArrowDown') {
                e.preventDefault();
                stage.current?.focus();
              }
            }}
          />
        </label>
        <span className="counter mono" aria-live="polite">
          {data && counterText(cur, count, data.total, data.query.trim() !== '')}
        </span>
      </div>
      <div className="dig-body">
        <div
          ref={stage}
          className={`crate-stage${flip.flipping ? ' grabbing' : ''}`}
          tabIndex={0}
          role="listbox"
          aria-label={`Crate, ${label.toLowerCase()}. Arrow keys flip, Enter pulls the front record out, A adds it to the draft.`}
          aria-activedescendant={front ? `crate-${front.persistent_id}` : undefined}
          onPointerDown={flip.handlers.onPointerDown}
          onPointerMove={flip.handlers.onPointerMove}
          onPointerUp={(e) => flip.handlers.onPointerUp(e, false)}
          onPointerCancel={(e) => flip.handlers.onPointerUp(e, true)}
          onPointerLeave={flip.handlers.onPointerLeave}
          onKeyDown={flip.handlers.onKeyDown}
        >
          {size > 0 && (
            <div className="world" style={{ '--s': `${size}px` } as React.CSSProperties}>
              <div
                className="floor-shadow"
                style={{
                  width: W * 1.3,
                  height: depth * 1.4,
                  left: -W * 0.65,
                  bottom: -depth * 0.7,
                  transform: `translate3d(0, 0, ${(fz + backZ(size)) / 2}px) rotateX(90deg)`,
                }}
              />
              {[-1, 1].map((side) => (
                <div
                  key={side}
                  className="crate-wall wall-side"
                  style={{
                    width: depth,
                    height: size * 0.375,
                    left: -depth / 2,
                    transform: `translate3d(${(side * W) / 2}px, 0, ${(fz + backZ(size)) / 2}px) rotateY(${-side * 90}deg)`,
                  }}
                />
              ))}
              {drawn.map(([id, m]) => {
                const p = pose(
                  {
                    slot: m.slot.x,
                    lift: m.lift.x * size * (Math.abs(m.slot.x - pos) < 0.5 ? 0.07 : 0.1),
                    hop: Math.max(0, m.hop),
                    out: m.out.x,
                    pulled: m.pulled.x,
                  },
                  pos,
                  size,
                  lean,
                  id === front?.persistent_id ? undefined : frontLift,
                );
                const hidden = m.carried || p.opacity < 0.01 || (m.wait > 0 && m.out.x > 0.98);

                return (
                  <div
                    key={id}
                    id={`crate-${id}`}
                    data-id={id}
                    className="sl"
                    role="option"
                    aria-selected={id === front?.persistent_id}
                    aria-label={`${m.track.title ?? 'Untitled'} by ${m.track.artist ?? 'unknown'}${inDraft.has(id) ? ', in the draft' : ''}`}
                    style={{
                      width: size,
                      height: size,
                      left: -size / 2,
                      visibility: hidden ? 'hidden' : undefined,
                      opacity: p.opacity,
                      transform: `translate3d(0, ${p.y.toFixed(1)}px, ${p.z.toFixed(1)}px) rotateX(${p.angle.toFixed(2)}deg)`,
                    }}
                  >
                    <div
                      className="sl-face"
                      ref={(node) => {
                        if (node) faces.current.set(id, node);
                        else faces.current.delete(id);
                      }}
                    >
                      <Sleeve trackId={id} title={m.track.title} />
                      {inDraft.has(id) && <span className="tag-draft">In draft</span>}
                      <div className="sl-shade" style={{ opacity: p.shade.toFixed(3) }} />
                    </div>
                    <div className="sl-top" style={{ background: edgeOf(id) }} />
                  </div>
                );
              })}
              <div
                className="crate-wall wall-front"
                data-label={`Library · ${label}`}
                style={{
                  width: W,
                  height: size * 0.3,
                  left: -W / 2,
                  transform: `translate3d(0, 0, ${fz}px)`,
                }}
              />
            </div>
          )}
          {data && count === 0 && (
            <div className="crate-empty">
              {data.query.trim() ? (
                <div>
                  <b>Nothing in the crate matches</b>Try an artist, an album or a genre.
                </div>
              ) : (
                <div>
                  <b>The crate is empty</b>Refresh the library from Claude or the CLI first.
                </div>
              )}
            </div>
          )}
          {error && (
            <div className="crate-empty">
              <div>
                <b>Couldn't read the library</b>
                {error}
              </div>
            </div>
          )}
          <p className={`crate-hint mono${isPulled ? ' off' : ''}`}>
            Scroll, drag or arrow keys to flip · drag the front record onto the rail
          </p>
        </div>
        <aside className="peek" aria-live="polite">
          {front && (
            <Spec
              track={front}
              pulled={isPulled}
              inDraft={inDraft.has(front.persistent_id)}
              canAdd={canAdd}
              lockedReason={lockedReason}
              onAdd={() => flip.add(front)}
              onPull={() => flip.togglePull(front.persistent_id)}
            />
          )}
        </aside>
      </div>
      {carrying &&
        createPortal(
          <div
            className="carry"
            aria-hidden="true"
            style={{
              width: carrying.size,
              height: carrying.size,
              transform: `translate3d(${(carrying.x - carrying.dx).toFixed(1)}px, ${(carrying.y - carrying.dy).toFixed(1)}px, 0) rotate(${carrying.tilt.toFixed(2)}deg)`,
            }}
          >
            <Sleeve trackId={carrying.track.persistent_id} title={carrying.track.title} />
          </div>,
          document.body,
        )}
      {returning &&
        createPortal(
          <Flight plan={returning} reduced={reduced} onLanded={flip.returned} />,
          document.body,
        )}
    </section>
  );
}
