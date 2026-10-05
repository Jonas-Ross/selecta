// The rail's motion: every record's slot is a spring, and a drag carries one
// record by hand while the rest open a slot for it. The hook owns the springs
// and the pointer state; the rail draws whatever they say this frame.
import { useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react';
import { dropSlot, slotUnder, withMoved } from '../reorder.js';
import { frameSprings, GROW, LIFT, rest, SLIDE, SQUASH, type Spring } from '../springs.js';
import type { Row } from '../state.js';
import { useFrameLoop } from './motion.js';

export type Anim = {
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

export function useRailSprings({
  items,
  hole,
  arrived,
  reduced,
  step,
  locked,
  scroller,
  recs,
  focused,
  onToggle,
  onMove,
}: {
  items: Row[];
  /** The slot held open for a record arriving from the crate. */
  hole?: number;
  /** The record that just landed from the crate, which only lands rather than growing in. */
  arrived?: Row;
  reduced: boolean;
  step: number;
  locked: boolean;
  scroller: RefObject<HTMLDivElement | null>;
  recs: RefObject<Map<string, HTMLElement>>;
  focused: RefObject<string | undefined>;
  onToggle: (id: string) => void;
  onMove: (id: string, to: number) => void;
}) {
  const anims = useRef(new Map<string, Anim>());
  const drag = useRef<Drag>(undefined);
  const mounted = useRef(false);
  const wasMoving = useRef(false);
  // New targets need a draw even when reduced motion snaps every spring to rest at once.
  const retargeted = useRef(false);
  const [landed, setLanded] = useState<{ id: string; at: number }>();
  const [, render] = useReducer((n: number) => n + 1, 0);

  const ids = items.map((row) => row.entry_id);
  const count = items.length;

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
    const frame = frameSprings(reduced, dt);
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

      frame.moving = true;
    }

    for (const [id, anim] of anims.current) {
      const held = d?.moved && d.id === id;

      if (held) anim.pos = { x: d.pos, v: d.vel };
      else anim.pos = frame.step(anim.pos, anim.target, SLIDE);

      anim.lift = frame.step(anim.lift, held ? 1 : 0, LIFT);
      anim.grow = frame.step(anim.grow, anim.leaving ? 0 : 1, GROW);

      if (anim.landIn !== undefined) {
        anim.landIn -= dt;
        frame.moving = true;

        if (anim.landIn <= 0) {
          anim.landIn = undefined;
          anim.squash = { x: 0, v: 9 };
          nudge(id);
        }
      }

      anim.squash = frame.step(anim.squash, 0, SQUASH);

      if (anim.leaving && anim.grow.x < 0.03) anims.current.delete(id);
    }

    // One more draw after the last move puts everything exactly on target.
    if (frame.moving || wasMoving.current || retargeted.current) render();

    wasMoving.current = frame.moving;
    retargeted.current = false;

    return frame.moving;
  });

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

    if (to !== ids.indexOf(d.id)) onMove(d.id, to);
    else retarget();

    kick();
  }

  function land(id: string) {
    if (reduced) return;

    anims.current.get(id)!.landIn = 0.1;
    setLanded({ id, at: performance.now() });
  }

  return {
    anims: anims.current,
    /** The record in hand and how far it has been lifted off the rail, while dragging. */
    held: drag.current?.moved ? { id: drag.current.id, dy: drag.current.dy } : undefined,
    landed,
    render,
    press,
    moveTo,
    release,
    land,
  };
}
