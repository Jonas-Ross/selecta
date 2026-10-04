// The crate's motion: the stack flips under scroll, drag and keys, each record
// shuffles, lifts and drops on its own springs, and the front record can be
// pulled out or carried to the rail by hand. The crate draws what this says.
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react';
import { flickTarget, rubberBand, wheelFlips } from '../crate.js';
import type { FlightPlan } from '../components/Flight.js';
import type { Rect } from '../flight.js';
import { frameSprings, rest, type Spring, type SpringConfig } from '../springs.js';
import type { Crate as CrateData, CrateTrack } from '../../shared/protocol.js';
import { useFrameLoop } from './motion.js';

export type Motion = {
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

export type Carry = {
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
const DRAG_THRESHOLD = 6;

const rectOf = (node: Element): Rect => {
  const r = node.getBoundingClientRect();

  return { left: r.left, top: r.top, width: r.width };
};

export function useCrateFlip({
  data,
  size,
  reduced,
  stage,
  faces,
  canAdd,
  onAdd,
  onCarry,
  onCarryEnd,
}: {
  data?: CrateData;
  size: number;
  reduced: boolean;
  stage: RefObject<HTMLDivElement | null>;
  faces: RefObject<Map<string, HTMLElement>>;
  canAdd: boolean;
  onAdd: (track: CrateTrack, from: Rect, at?: number) => void;
  onCarry: (x: number, y: number) => { at: number; size: number } | undefined;
  onCarryEnd: () => void;
}) {
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

    // The new list starts at its front; travelling back from deep in the old one would sweep
    // past indexes the new list doesn't have.
    Object.assign(crate.current, { pos: rest(0), target: 0, settling: false });
    setPulledId(undefined);
    dirty.current = true;
    kick();
  }, [data, reduced]);

  const kick = useFrameLoop((dt) => {
    const frame = frameSprings(reduced, dt);
    const c = crate.current;

    if (press.current?.kind !== 'flip') {
      c.pos = frame.step(c.pos, c.target, FLIP);

      if (c.settling && Math.abs(c.pos.x - c.target) < 0.04) {
        c.settling = false;

        if (!reduced) c.wobble = { x: c.dir * 4, v: 0 };
      }
    }

    c.wobble = frame.step(c.wobble, 0, WOBBLE);

    const frontId = data?.tracks[Math.round(c.pos.x)]?.persistent_id;

    for (const [id, m] of motions.current) {
      if (m.wait > 0) {
        m.wait -= dt;
        frame.moving = true;
        continue;
      }

      m.slot = frame.step(m.slot, m.target, SHUFFLE);

      if (m.hop >= 0) {
        m.hop = m.hop + dt / 0.6 >= 1 ? -1 : m.hop + dt / 0.6;
        frame.moving = true;
      }

      m.lift = frame.step(m.lift, hovered.current === id && !press.current ? 1 : 0, HOVER);
      m.out = frame.step(m.out, m.leaving ? 1 : 0, OUT);
      m.pulled = frame.step(m.pulled, pulledId === id && id === frontId ? 1 : 0, PULL);

      if (m.leaving && m.out.x > 0.98) motions.current.delete(id);
    }

    if (frame.moving || wasMoving.current || dirty.current) render();

    wasMoving.current = frame.moving;
    dirty.current = false;

    return frame.moving;
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

  const togglePull = (id?: string) => setPulledId((current) => (current === id ? undefined : id));

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
      if (p.front) togglePull(p.id);
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

  function onPointerLeave() {
    if (!press.current && hovered.current) {
      hovered.current = undefined;
      kick();
    }
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
    const next = over ? over.size : (faceRect(c.track.persistent_id)?.width ?? c.size);
    const k = next / c.size;
    const tilt = reduced ? 0 : Math.max(-10, Math.min(10, (x - c.x) * 0.6));

    carrying.current = {
      ...c,
      x,
      y,
      dx: c.dx * k,
      dy: c.dy * k,
      size: next,
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

  // A carried record that flew back has landed in its slot again.
  function returned() {
    const m = returning && motions.current.get(returning.trackId);

    if (m) m.carried = false;

    setReturning(undefined);
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
      togglePull(front.persistent_id);
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

  return {
    motions: motions.current,
    crate: crate.current,
    flipping: press.current?.kind === 'flip',
    cur,
    front,
    pulledId,
    carrying: carrying.current,
    returning,
    returned,
    add,
    togglePull,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerLeave, onKeyDown },
  };
}
