// The crate: the library as records standing in a bin, flipped through by
// scroll, drag or arrow keys. The record in front can be pulled out to read,
// added to the draft, or carried onto the rail by hand.
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { selecta } from '../api.js';
import {
  backZ,
  counterText,
  flickTarget,
  frontZ,
  pose,
  rubberBand,
  visibleRange,
  wheelFlips,
} from '../crate.js';
import type { Rect } from '../flight.js';
import { useFrameLoop, useReducedMotion } from '../hooks/motion.js';
import { rest, settled, stepSpring, type Spring, type SpringConfig } from '../springs.js';
import type { Crate as CrateData } from '../../shared/protocol.js';
import { Flight, type FlightPlan } from './Flight.js';
import { Sleeve } from './Sleeve.js';
import { Spec } from './Spec.js';

export type CrateTrack = CrateData['tracks'][number];

type Motion = {
  track: CrateTrack;
  slot: Spring;
  target: number;
  lift: Spring;
  out: Spring;
  pulled: Spring;
  hop: number; // progress through a shuffle's hop, or -1 when not hopping
  wait: number; // seconds before a staggered move starts
  leaving: boolean;
  carried: boolean;
};

type Press = {
  kind: 'pending' | 'flip' | 'carry';
  pointerId: number;
  x0: number;
  y0: number;
  pos0: number;
  id?: string;
  front: boolean;
  samples: [number, number][];
};

type Carry = {
  track: CrateTrack;
  x: number;
  y: number;
  dx: number;
  dy: number;
  size: number;
  tilt: number;
};

// The flip settles like a heavy stack: quick, barely overshooting.
const FLIP: SpringConfig = { stiffness: 150, damping: 22 };
// The record you stop on rocks once against its neighbours.
const WOBBLE: SpringConfig = { stiffness: 110, damping: 6 };
const SHUFFLE: SpringConfig = { stiffness: 140, damping: 20 };
const HOVER: SpringConfig = { stiffness: 300, damping: 26 };
const OUT: SpringConfig = { stiffness: 160, damping: 22 };
const PULL: SpringConfig = { stiffness: 120, damping: 17 };
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
const DRAG_THRESHOLD = 6;

const edgeOf = (id: string) =>
  EDGES[[...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % EDGES.length];
const rectOf = (node: Element): Rect => {
  const r = node.getBoundingClientRect();

  return { left: r.left, top: r.top, width: r.width };
};

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
  const motions = useRef(new Map<string, Motion>());
  const crate = useRef({ pos: rest(0), target: 0, wobble: rest(0), dir: 0, settling: false });
  const press = useRef<Press>(undefined);
  const hovered = useRef<string>(undefined);
  const wheel = useRef(0);
  const wasMoving = useRef(false);
  const dirty = useRef(false);
  const [pulledId, setPulledId] = useState<string>();
  const carrying = useRef<Carry>(undefined);
  const [returning, setReturning] = useState<FlightPlan>();
  const flying = useRef(returning);

  flying.current = returning;
  const [, render] = useReducer((n: number) => n + 1, 0);

  const tracks = data?.tracks ?? [];
  const count = tracks.length;
  const cur = Math.max(0, Math.min(count - 1, Math.round(crate.current.pos.x)));
  const front = tracks[cur];

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

  // A new list: misses lift out, newcomers drop in, and the rest shuffle to their new place.
  useLayoutEffect(() => {
    if (!data) return;

    const present = new Set<string>();
    const first = motions.current.size === 0;
    let gone = 0;

    data.tracks.forEach((track, index) => {
      const id = track.persistent_id;
      const near = index < 24;
      const wait = reduced || !near ? 0 : index * 0.035;
      const motion = motions.current.get(id);

      present.add(id);

      if (!motion || motion.leaving) {
        motions.current.set(id, {
          track,
          slot: rest(index),
          target: index,
          lift: rest(0),
          out: rest(reduced || (!first && !near) ? 0 : 1),
          pulled: rest(0),
          hop: -1,
          wait,
          leaving: false,
          carried: false,
        });
      } else {
        Object.assign(motion, { track, wait });

        if (motion.target !== index) {
          motion.target = index;
          motion.hop = reduced || !near ? -1 : 0;
        }
      }
    });

    for (const [id, motion] of motions.current)
      if (!present.has(id) && !motion.leaving) {
        motion.leaving = true;
        motion.wait = reduced ? 0 : (gone++ % 8) * 0.025;
      }

    crate.current.target = 0;
    setPulledId(undefined);
    dirty.current = true;
    kick();
  }, [data, reduced]);

  const kick = useFrameLoop((dt) => {
    let moving = false;
    const c = crate.current;
    const spring = (s: Spring, target: number, config: SpringConfig) => {
      const next = reduced ? rest(target) : stepSpring(s, target, config, dt);

      moving ||= !settled(next, target);

      return next;
    };

    if (press.current?.kind !== 'flip') {
      c.pos = spring(c.pos, c.target, FLIP);

      if (c.settling && Math.abs(c.pos.x - c.target) < 0.04) {
        c.settling = false;

        if (!reduced) c.wobble = { x: c.dir * 4, v: 0 };
      }
    }

    c.wobble = spring(c.wobble, 0, WOBBLE);

    const frontId = data?.tracks[Math.round(c.pos.x)]?.persistent_id;

    for (const [id, m] of motions.current) {
      if (m.wait > 0) {
        m.wait -= dt;
        moving = true;
        continue;
      }

      m.slot = spring(m.slot, m.target, SHUFFLE);

      if (m.hop >= 0) {
        m.hop = m.hop + dt / 0.6 >= 1 ? -1 : m.hop + dt / 0.6;
        moving = true;
      }

      m.lift = spring(m.lift, hovered.current === id && !press.current ? 1 : 0, HOVER);
      m.out = spring(m.out, m.leaving ? 1 : 0, OUT);
      m.pulled = spring(m.pulled, pulledId === id && id === frontId ? 1 : 0, PULL);

      if (m.leaving && m.out.x > 0.98) motions.current.delete(id);
    }

    if (moving || wasMoving.current || dirty.current) render();

    wasMoving.current = moving;
    dirty.current = false;

    return moving;
  });

  useEffect(() => {
    dirty.current = true;
    kick();
  }, [pulledId, kick]);

  function goTo(target: number) {
    const c = crate.current;
    const next = Math.max(0, Math.min(count - 1, Math.round(target)));

    if (!count) return;

    setPulledId(undefined);
    c.dir = Math.sign(next - c.pos.x) || c.dir;
    c.target = next;
    c.settling = next !== Math.round(c.pos.x);
    kick();
  }

  function faceRect(id: string): Rect | undefined {
    const node = faces.current.get(id);

    return node && rectOf(node);
  }

  function add(track: CrateTrack) {
    const from = faceRect(track.persistent_id);

    if (canAdd && from) onAdd(track, from);
  }

  // Chromium's 3D hit test can pick a sleeve standing behind the front one, so
  // anything inside the front sleeve's face counts as the front sleeve.
  function sleeveAt(x: number, y: number): string | undefined {
    const id = front?.persistent_id;
    const r = id && faces.current.get(id)?.getBoundingClientRect();

    if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id;

    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('.sl');

    return hit?.dataset.id;
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !count) return;

    const id = sleeveAt(e.clientX, e.clientY);

    e.currentTarget.setPointerCapture(e.pointerId);
    crate.current.pos.v = 0;
    press.current = {
      kind: 'pending',
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      pos0: crate.current.pos.x,
      id,
      front: id !== undefined && id === front?.persistent_id,
      samples: [[performance.now(), crate.current.pos.x]],
    };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const p = press.current;

    if (!p) {
      const id = sleeveAt(e.clientX, e.clientY);
      const m = id && motions.current.get(id);

      // Only records still standing lift to the hand; flipped ones lie under the front wall.
      const next = m && m.slot.x - crate.current.pos.x > -0.5 ? id : undefined;

      if (next !== hovered.current) {
        hovered.current = next;
        kick();
      }

      return;
    }

    if (p.pointerId !== e.pointerId) return;

    const dx = e.clientX - p.x0;
    const dy = e.clientY - p.y0;

    if (p.kind === 'pending' && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      if (p.front && canAdd && front) startCarry(e, front);
      else {
        p.kind = 'flip';
        setPulledId(undefined);
      }
    }

    if (p.kind === 'flip') {
      const now = performance.now();

      crate.current.pos = { x: rubberBand(p.pos0 + dy / (size * 0.3), count), v: 0 };
      p.samples.push([now, crate.current.pos.x]);

      if (p.samples.length > 8) p.samples.shift();

      kick();
    } else if (p.kind === 'carry') moveCarry(e.clientX, e.clientY);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) {
    const p = press.current;

    if (!p || p.pointerId !== e.pointerId) return;

    press.current = undefined;

    if (p.kind === 'pending' && !cancelled) {
      if (p.front) setPulledId((id) => (id === p.id ? undefined : p.id));
      else if (p.id) goTo(tracks.findIndex((track) => track.persistent_id === p.id));
    } else if (p.kind === 'flip') {
      const now = performance.now();
      const [t0, x0] = p.samples.find(([t]) => now - t < 120) ?? p.samples[0];
      const [t1, x1] = p.samples[p.samples.length - 1];
      const velocity = (x1 - x0) / Math.max(0.016, (t1 - t0) / 1000);

      goTo(reduced ? crate.current.pos.x : flickTarget(crate.current.pos.x, velocity, count));
    } else if (p.kind === 'carry') endCarry(cancelled);

    kick();
  }

  function startCarry(e: React.PointerEvent, track: CrateTrack) {
    const r = faceRect(track.persistent_id);
    const m = motions.current.get(track.persistent_id);

    if (!r || !m) return;

    press.current!.kind = 'carry';
    m.carried = true;
    hovered.current = undefined;
    setPulledId(undefined);
    carrying.current = {
      track,
      x: e.clientX,
      y: e.clientY,
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
      size: r.width,
      tilt: 0,
    };
    moveCarry(e.clientX, e.clientY);
  }

  function moveCarry(x: number, y: number) {
    const c = carrying.current;

    if (!c) return;

    const over = onCarry(x, y);
    // Shrinks toward the size it will stand at on the rail, keeping the hand on the same spot.
    const size = over ? over.size : (faceRect(c.track.persistent_id)?.width ?? c.size);
    const k = size / c.size;
    const tilt = reduced ? 0 : Math.max(-10, Math.min(10, (x - c.x) * 0.6));

    carrying.current = {
      ...c,
      x,
      y,
      dx: c.dx * k,
      dy: c.dy * k,
      size,
      tilt: c.tilt * 0.7 + tilt * 0.3,
    };
    render();
  }

  function endCarry(cancelled: boolean) {
    const c = carrying.current;

    if (!c) return;

    const at = cancelled ? undefined : onCarry(c.x, c.y)?.at;
    const box: Rect = { left: c.x - c.dx, top: c.y - c.dy, width: c.size };
    const id = c.track.persistent_id;
    const m = motions.current.get(id);

    carrying.current = undefined;
    onCarryEnd();

    if (at !== undefined) {
      onAdd(c.track, box, at);

      // The record stays in the library, so a fresh copy drops back into the crate.
      if (m) Object.assign(m, { carried: false, out: rest(reduced ? 0 : 1) });

      kick();

      return;
    }

    const home = faceRect(id);
    const before = flying.current && motions.current.get(flying.current.trackId);

    // A newer return replaces the one in the air, whose sleeve then goes straight home.
    if (before) before.carried = false;

    if (home && !reduced)
      setReturning({ key: Date.now(), trackId: id, title: c.track.title, from: box, to: home });
    else if (m) m.carried = false;

    dirty.current = true;
    kick();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const flips: Record<string, number> = {
      ArrowDown: 1,
      ArrowRight: 1,
      PageDown: 5,
      ArrowUp: -1,
      ArrowLeft: -1,
      PageUp: -5,
    };
    const base = crate.current.target;

    if (e.key in flips) {
      e.preventDefault();
      goTo(base + flips[e.key]);
    } else if (e.key === 'Home') goTo(0);
    else if (e.key === 'End') goTo(count - 1);
    else if (e.key === 'Enter' && front) {
      e.preventDefault();
      setPulledId((id) => (id === front.persistent_id ? undefined : front.persistent_id));
    } else if (e.key.toLowerCase() === 'a' && !e.metaKey && !e.ctrlKey && front) add(front);
    else if (e.key === 'Escape') setPulledId(undefined);
  }

  const flipBy = useRef<(flips: number) => void>(() => {});

  flipBy.current = (flips) => goTo(crate.current.target + flips);

  // Wheel and trackpad flip whole records; React's wheel listener is passive, so this one isn't.
  useEffect(() => {
    const node = stage.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheel.current += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;

      const { flips, rest: left } = wheelFlips(wheel.current);

      wheel.current = left;

      if (flips) flipBy.current(flips);
    };

    node.addEventListener('wheel', onWheel, { passive: false });

    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  const c = crate.current;
  const pos = c.pos.x;
  const lean = reduced ? 0 : Math.max(-16, Math.min(16, -c.pos.v * 4.5)) + c.wobble.x;
  const frontMotion = front && motions.current.get(front.persistent_id);
  const frontLift = frontMotion
    ? { lift: frontMotion.lift.x * size * 0.07, pulled: frontMotion.pulled.x }
    : undefined;
  const [lo, hi] = visibleRange(pos, count);
  const drawn = [...motions.current.entries()].filter(
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
          className={`crate-stage${press.current?.kind === 'flip' ? ' grabbing' : ''}`}
          tabIndex={0}
          role="listbox"
          aria-label={`Crate, ${label.toLowerCase()}. Arrow keys flip, Enter pulls the front record out, A adds it to the draft.`}
          aria-activedescendant={front ? `crate-${front.persistent_id}` : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => onPointerUp(e, false)}
          onPointerCancel={(e) => onPointerUp(e, true)}
          onPointerLeave={() => {
            if (!press.current && hovered.current) {
              hovered.current = undefined;
              kick();
            }
          }}
          onKeyDown={onKeyDown}
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
              onAdd={() => add(front)}
              onPull={() =>
                setPulledId((id) => (id === front.persistent_id ? undefined : front.persistent_id))
              }
            />
          )}
        </aside>
      </div>
      {carrying.current &&
        createPortal(
          <div
            className="carry"
            aria-hidden="true"
            style={{
              width: carrying.current.size,
              height: carrying.current.size,
              transform: `translate3d(${(carrying.current.x - carrying.current.dx).toFixed(1)}px, ${(carrying.current.y - carrying.current.dy).toFixed(1)}px, 0) rotate(${carrying.current.tilt.toFixed(2)}deg)`,
            }}
          >
            <Sleeve
              trackId={carrying.current.track.persistent_id}
              title={carrying.current.track.title}
            />
          </div>,
          document.body,
        )}
      {returning &&
        createPortal(
          <Flight
            plan={returning}
            reduced={reduced}
            onLanded={() => {
              const m = motions.current.get(returning.trackId);

              if (m) m.carried = false;

              setReturning(undefined);
              dirty.current = true;
              kick();
            }}
          />,
          document.body,
        )}
    </section>
  );
}
