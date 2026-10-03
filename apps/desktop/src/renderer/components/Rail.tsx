// The draft as records standing on a lit rail, tempo lane above and key lane
// below. Every record's slot is a spring, so a drag, a removal or Claude's
// edit moves records the same way, and the lanes are redrawn from where the
// records are on each frame rather than where they will end up.
import {
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import type { Rect } from '../flight.js';
import {
  bpmScale,
  formatClock,
  GUTTER,
  keyRings,
  keyY,
  labelFade,
  PAD,
  shelfLayout,
  slotX,
  startTimes,
  stepPath,
  tempoY,
  type Box,
} from '../lanes.js';
import { useFrameLoop, useReducedMotion } from '../motion.js';
import { dropSlot, landingIndex, slotUnder, withMoved } from '../reorder.js';
import { GROW, LIFT, rest, settled, SLIDE, SQUASH, stepSpring, type Spring } from '../springs.js';
import type { Row } from '../state.js';
import { Term } from './Explain.js';
import { JoinMarker } from './JoinMarker.js';
import { Sleeve } from './Sleeve.js';
import { ValueLabel } from './ValueLabel.js';

type Anim = {
  row: Row;
  target: number;
  pos: Spring;
  lift: Spring;
  squash: Spring;
  grow: Spring;
  leaving: boolean;
  landIn?: number; // seconds until the landing squash, once the lift has dropped
};

type Drag = {
  id: string;
  pointerId: number;
  x0: number;
  y0: number;
  scroll0: number;
  p0: number;
  pos: number;
  vel: number;
  dy: number;
  slot: number;
  moved: boolean;
  clientX: number;
  samples: [number, number][];
};

// Pixels a press may wander before it counts as a drag rather than a click.
const DRAG_THRESHOLD = 5;
// Within this many pixels of the rail's ends, a dragged record pans it.
const EDGE = 64;

/** A gap held open on the rail for a record arriving from the crate. */
export type Opening = {
  at: number;
  // Set once the record is on its way: the entry for this track that isn't in `known` is it.
  trackId?: string;
  known?: Set<string>;
};

export type RailHandle = {
  /** Where a record carried to (x, y) would be inserted, and how big it would stand. */
  landing: (x: number, y: number, current?: number) => { at: number; size: number } | undefined;
  /** The box a record standing in slot `at` occupies on screen, scrolled into view first. */
  slotRect: (at: number) => Rect | undefined;
};

export type RailProps = {
  items: Row[];
  selected: Set<string>;
  locked: boolean;
  onToggle: (entryId: string) => void;
  // What Enter or a click does to a record, for its label.
  pickVerb?: string;
  // The entry Music.app is playing from this draft, marked on the rail.
  now?: string;
  onClear: () => void;
  onMove: (entryId: string, to: number) => void;
  onRemove: (entryId: string) => void;
  empty?: ReactNode;
  opening?: Opening;
  handle?: Ref<RailHandle>;
};

export function Rail({
  items,
  selected,
  locked,
  onToggle,
  pickVerb = 'selects',
  now,
  onClear,
  onMove,
  onRemove,
  empty,
  opening,
  handle,
}: RailProps) {
  const reduced = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const anims = useRef(new Map<string, Anim>());
  const drag = useRef<Drag>(undefined);
  const recs = useRef(new Map<string, HTMLElement>());
  const focused = useRef<string>(undefined);
  const mounted = useRef(false);
  const wasMoving = useRef(false);
  // New targets need a draw even when reduced motion snaps every spring to rest at once.
  const retargeted = useRef(false);
  const [landed, setLanded] = useState<{ id: string; at: number }>();
  const [said, setSaid] = useState('');
  const [edges, setEdges] = useState({ left: false, right: false });
  const [, render] = useReducer((n: number) => n + 1, 0);

  const ids = items.map((row) => row.entry_id);
  const count = items.length;
  const arrived =
    opening?.trackId === undefined
      ? undefined
      : items.find((row) => row.track_id === opening.trackId && !opening.known?.has(row.entry_id));
  // The gap closes the moment the record it was held for stands in it.
  const hole = opening && !arrived ? Math.min(opening.at, count) : undefined;
  const rings = useMemo(() => keyRings(items.map((row) => row.camelot)), [items]);
  const scale = useMemo(() => bpmScale(items.map((row) => row.bpm)), [items]);
  const shelf = shelfLayout(dims.h, rings);
  const step = shelf.step;

  useLayoutEffect(() => {
    const node = box.current!;
    const measure = () => setDims({ w: node.clientWidth, h: node.clientHeight });
    const observer = new ResizeObserver(measure);

    measure();
    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  function retarget() {
    const d = drag.current;
    const order = d?.moved ? withMoved(ids, d.id, d.slot) : ids;

    order.forEach((id, k) => {
      const anim = anims.current.get(id);
      const index = hole !== undefined && k >= hole ? k + 1 : k;

      if (!anim || anim.target === index) return;

      anim.target = index;

      // Without travel, a record that changed place fades back in where it now stands.
      if (reduced && mounted.current)
        recs.current.get(id)?.animate([{ opacity: 0.15 }, { opacity: 1 }], 200);
    });
  }

  // Claude's edits, removals and drops all arrive here as a new order.
  useLayoutEffect(() => {
    const present = new Set(ids);

    items.forEach((row, index) => {
      const anim = anims.current.get(row.entry_id);

      if (anim) Object.assign(anim, { row, leaving: false });
      else
        anims.current.set(row.entry_id, {
          row,
          target: index,
          pos: rest(index),
          lift: rest(0),
          squash: rest(0),
          // A record Claude adds grows onto the rail; the draft's first records are just there,
          // and one thrown from the crate has already flown in, so it only lands.
          grow: rest(mounted.current && !reduced && row !== arrived ? 0 : 1),
          leaving: false,
          landIn: row === arrived && !reduced ? 0 : undefined,
        });
    });

    for (const [id, anim] of anims.current)
      if (!present.has(id)) {
        if (reduced) anims.current.delete(id);
        else anim.leaving = true;
      }

    if (drag.current && !present.has(drag.current.id)) drag.current = undefined;

    retarget();
    retargeted.current = true;

    if (items.length) mounted.current = true;

    kick();

    // React moves a reordered node, which drops its focus; put it back.
    const keep = focused.current && recs.current.get(focused.current);

    if (keep && document.activeElement !== keep && document.activeElement === document.body)
      keep.focus({ preventScroll: true });
  }, [items, reduced, hole]);

  const kick = useFrameLoop((dt) => {
    let moving = false;
    const d = drag.current;
    const sc = scroller.current;

    if (d?.moved && sc) {
      const r = sc.getBoundingClientRect();
      const over =
        d.clientX > r.right - EDGE
          ? d.clientX - (r.right - EDGE)
          : d.clientX < r.left + EDGE
            ? d.clientX - (r.left + EDGE)
            : 0;

      if (over) {
        sc.scrollLeft += Math.sign(over) * Math.min(14, Math.abs(over) * 0.25) * dt * 60;
        follow(d);
      }

      moving = true;
    }

    const spring = (s: Spring, target: number, config: typeof SLIDE) => {
      const next = reduced ? rest(target) : stepSpring(s, target, config, dt);

      moving ||= !settled(next, target);

      return next;
    };

    for (const [id, anim] of anims.current) {
      const held = d?.moved && d.id === id;

      if (held) anim.pos = { x: d.pos, v: d.vel };
      else anim.pos = spring(anim.pos, anim.target, SLIDE);

      anim.lift = spring(anim.lift, held ? 1 : 0, LIFT);
      anim.grow = spring(anim.grow, anim.leaving ? 0 : 1, GROW);

      if (anim.landIn !== undefined) {
        anim.landIn -= dt;
        moving = true;

        if (anim.landIn <= 0) {
          anim.landIn = undefined;
          anim.squash = { x: 0, v: 9 };
          nudge(id);
        }
      }

      anim.squash = spring(anim.squash, 0, SQUASH);

      if (anim.leaving && anim.grow.x < 0.03) anims.current.delete(id);
    }

    // One more draw after the last move puts everything exactly on target.
    if (moving || wasMoving.current || retargeted.current) render();

    wasMoving.current = moving;
    retargeted.current = false;

    return moving;
  });

  useImperativeHandle(handle, () => ({
    landing(x, y, current) {
      const area = box.current?.getBoundingClientRect();
      const sc = scroller.current;

      if (!area || !sc || y < area.top || y > area.bottom || x < area.left || x > area.right)
        return;

      const raw = (x - sc.getBoundingClientRect().left + sc.scrollLeft - PAD) / step;

      return { at: landingIndex(raw, count, current), size: shelf.size };
    },
    slotRect(at) {
      const area = box.current?.getBoundingClientRect();
      const sc = scroller.current;

      if (!area || !sc) return;

      reveal(at, true);

      return {
        left: sc.getBoundingClientRect().left - sc.scrollLeft + slotX(at, step) + shelf.gap / 2,
        top: area.top + shelf.rail - shelf.size,
        width: shelf.size,
      };
    },
  }));

  // Neighbours of a landing record get jostled outward.
  function nudge(id: string) {
    const index = ids.indexOf(id);

    for (const [k, dir] of [
      [index - 1, -1],
      [index + 1, 1],
    ]) {
      const anim = anims.current.get(ids[k]);

      if (anim) anim.pos.v += dir * 1.6;
    }
  }

  function follow(d: Drag) {
    const sc = scroller.current!;

    d.pos = Math.max(
      -0.6,
      Math.min(count - 0.4, d.p0 + (d.clientX - d.x0 + sc.scrollLeft - d.scroll0) / step),
    );

    const now = performance.now();

    d.samples.push([now, d.pos]);

    if (d.samples.length > 8) d.samples.shift();

    const [t0, p0] = d.samples[0];

    d.vel += ((d.pos - p0) / Math.max(0.016, (now - t0) / 1000) - d.vel) * 0.4;

    const slot = slotUnder(d.pos, count);

    if (slot !== d.slot) {
      d.slot = slot;
      retarget();
    }
  }

  function press(e: React.PointerEvent<HTMLElement>, id: string) {
    if (e.button !== 0) return;

    e.currentTarget.setPointerCapture(e.pointerId);

    const index = ids.indexOf(id);

    drag.current = {
      id,
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      scroll0: scroller.current!.scrollLeft,
      p0: index,
      pos: index,
      vel: 0,
      dy: 0,
      slot: index,
      moved: false,
      clientX: e.clientX,
      samples: [[performance.now(), index]],
    };
  }

  function moveTo(e: React.PointerEvent<HTMLElement>) {
    const d = drag.current;

    if (!d || d.pointerId !== e.pointerId) return;

    d.clientX = e.clientX;

    if (!d.moved) {
      if (locked || Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_THRESHOLD) return;

      d.moved = true;
    }

    // Lifted to carry: it follows the hand a little vertically, never off the rail.
    d.dy = Math.max(-20, Math.min(8, (e.clientY - d.y0) * 0.25));
    follow(d);
    kick();
  }

  function release(e: React.PointerEvent<HTMLElement>, cancelled: boolean) {
    const d = drag.current;

    if (!d || d.pointerId !== e.pointerId) return;

    drag.current = undefined;

    if (!d.moved) {
      if (!cancelled) onToggle(d.id);

      return;
    }

    const anim = anims.current.get(d.id)!;
    // The draft can lock mid-drag (a preview linked elsewhere); then the record goes back.
    const to = cancelled || locked ? ids.indexOf(d.id) : dropSlot(d.pos, d.vel, count);

    anim.pos = { x: d.pos, v: Math.max(-14, Math.min(14, d.vel)) };
    land(d.id);

    if (to !== ids.indexOf(d.id)) move(d.id, to);
    else retarget();

    kick();
  }

  function land(id: string) {
    if (reduced) return;

    anims.current.get(id)!.landIn = 0.1;
    setLanded({ id, at: performance.now() });
  }

  function move(id: string, to: number) {
    const row = items.find((item) => item.entry_id === id);

    onMove(id, to);
    setSaid(`${row?.title ?? 'Track'} moved to ${to + 1} of ${count}`);
  }

  // Fades mark the ends that have more records past them.
  function edge(node: HTMLElement) {
    const left = node.scrollLeft > 1;
    const right = node.scrollLeft + node.clientWidth < node.scrollWidth - 1;

    if (left !== edges.left || right !== edges.right) setEdges({ left, right });
  }

  useLayoutEffect(() => {
    if (scroller.current) edge(scroller.current);
  });

  function reveal(index: number, now = false) {
    const sc = scroller.current;

    if (!sc) return;

    const x0 = slotX(index, step) - PAD;
    const x1 = slotX(index + 1, step) + PAD;
    const left =
      x0 < sc.scrollLeft ? x0 : x1 > sc.scrollLeft + sc.clientWidth ? x1 - sc.clientWidth : -1;

    if (left >= 0) sc.scrollTo({ left, behavior: reduced || now ? 'auto' : 'smooth' });
  }

  function key(e: React.KeyboardEvent<HTMLElement>, id: string) {
    const index = ids.indexOf(id);
    const dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];

    if (dir !== undefined) {
      e.preventDefault();

      const next = index + dir;

      if (next < 0 || next >= count) return;

      if (!e.altKey) return recs.current.get(ids[next])?.focus({ preventScroll: true });

      if (locked) return;

      land(id);
      move(id, next);
      reveal(next);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle(id);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !locked && count > 1) {
      e.preventDefault();
      focused.current = ids[index + 1] ?? ids[index - 1];
      recs.current.get(focused.current)?.focus({ preventScroll: true });
      onRemove(id);
    } else if (e.key === 'Escape') onClear();
  }

  // What is on the rail now, in the order it stands this frame.
  const standing = [...anims.current.entries()]
    .filter(([, anim]) => !anim.leaving)
    .sort(([, a], [, b]) => a.pos.x - b.pos.x);
  const held = drag.current?.moved ? drag.current.id : undefined;
  const slots = standing.map(([id, { row, pos }]) => {
    const x0 = slotX(pos.x, step);

    return {
      id,
      row,
      x0,
      tempo: row.bpm === undefined ? undefined : tempoY(row.bpm, scale, shelf.tempo),
      key: keyY(row.camelot, shelf.bands),
    };
  });
  const path = (y: 'tempo' | 'key') =>
    stepPath(
      slots.map((slot) => ({ x0: slot.x0, x1: slot.x0 + step, y: slot[y], hot: slot.id === held })),
    );
  const tempo = path('tempo');
  const keys = path('key');
  const starts = startTimes(slots.map((slot) => slot.row.duration_seconds));
  const view = Math.max(0, dims.w - GUTTER);
  const width = Math.max(view, PAD * 2 + (count + (hole === undefined ? 0 : 1)) * step);
  const { bands } = shelf;
  // Labels and joins are drawn only near the visible stretch; a long draft has hundreds.
  const scrolled = scroller.current?.scrollLeft ?? 0;
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
    <div className={`rail-area${locked ? ' locked' : ''}`} ref={box}>
      {dims.w > 0 && (
        <>
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
          <div className="rail-line" style={{ top: shelf.rail }} />
          <div
            className={`rail-scroll${edges.left ? ' more-left' : ''}${edges.right ? ' more-right' : ''}`}
            ref={scroller}
            onScroll={(e) => {
              edge(e.currentTarget);
              render();
            }}
            onWheel={(e) => {
              if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
            }}
          >
            <div className="rail-content" style={{ width }}>
              <svg className="lanes" width={width} height={dims.h} aria-hidden="true">
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
                        {formatClock(starts[k].seconds)}
                        {starts[k].partial ? '+' : ''}
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
                const prev = slots[k];
                // A join's room is the narrower slot beside it; squeezed joins drop their words first.
                const room = Math.min(
                  slot.x0 - prev.x0,
                  (slots[k + 2]?.x0 ?? slot.x0 + step) - slot.x0,
                );

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
                        landed && (landed.id === slot.id || landed.id === prev.id)
                          ? landed.at
                          : undefined
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

              <div className="recs" role="list" aria-label="Draft order">
                {[...ids, ...[...anims.current.keys()].filter((id) => !ids.includes(id))].map(
                  (id) => {
                    const anim = anims.current.get(id);

                    if (!anim) return null;

                    const { row, pos, lift, squash, grow, leaving } = anim;
                    const index = ids.indexOf(id);
                    const isHeld = id === held;
                    const x = slotX(pos.x, step) + shelf.gap / 2;
                    // Tops lag the push: the record in hand leans further than ones it shoves along.
                    const lean = isHeld ? 2.4 : 1.4;
                    const tilt = reduced ? 0 : Math.max(-8, Math.min(8, -pos.v * lean));
                    const sq = squash.x;
                    const isSelected = selected.has(id);
                    const label = [
                      `${index + 1} of ${count}: ${row.title ?? row.track_id} by ${row.artist ?? 'unknown'}`,
                      row.bpm === undefined ? 'tempo not measured' : `${Math.round(row.bpm)} BPM`,
                      row.camelot ?? 'key not measured',
                      ...(isSelected ? ['selected for feedback'] : []),
                      ...(id === now ? ['now playing'] : []),
                    ].join(', ');

                    return (
                      <div
                        key={id}
                        ref={(node) => {
                          if (node) recs.current.set(id, node);
                          else recs.current.delete(id);
                        }}
                        className={`rec${isSelected ? ' sel' : ''}${id === now ? ' now' : ''}${isHeld ? ' held' : ''}${leaving ? ' leaving' : ''}`}
                        role="listitem"
                        tabIndex={leaving ? -1 : 0}
                        aria-current={id === now ? 'true' : undefined}
                        aria-label={`${label}. Enter ${pickVerb}${locked ? '' : ', Alt and arrow keys move it, Delete removes it'}.`}
                        style={{
                          width: shelf.size,
                          height: shelf.size,
                          transform: `translate3d(${x.toFixed(1)}px, ${(shelf.rail - shelf.size + (isHeld ? drag.current!.dy : 0)).toFixed(1)}px, 0)`,
                          zIndex: isHeld || lift.x > 0.02 ? 5 : undefined,
                        }}
                        onPointerDown={(e) => !leaving && press(e, id)}
                        onPointerMove={moveTo}
                        onPointerUp={(e) => release(e, false)}
                        onPointerCancel={(e) => release(e, true)}
                        onKeyDown={(e) => key(e, id)}
                        onFocus={() => {
                          focused.current = id;
                          reveal(index);
                        }}
                        onBlur={() => (focused.current = undefined)}
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
                              onRemove(id);
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
                  },
                )}
              </div>
            </div>
          </div>
          {count === 0 && empty && <div className="rail-empty">{empty}</div>}
        </>
      )}
      <p className="sr" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
