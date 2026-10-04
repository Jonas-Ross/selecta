// The draft as records standing on a lit rail, tempo lane above and key lane
// below. Every record's slot is a spring (`useRailSprings`), so a drag, a
// removal or Claude's edit moves records the same way, and the lanes are
// redrawn from where the records are on each frame rather than where they will end up.
import {
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import type { Rect } from '../flight.js';
import { useReducedMotion } from '../hooks/motion.js';
import { useRailSprings } from '../hooks/useRailSprings.js';
import { bpmScale, GUTTER, keyRings, PAD, shelfLayout, slotX } from '../lanes.js';
import { landingIndex } from '../reorder.js';
import type { Row } from '../state.js';
import { RailGutter, RailLanes } from './RailLanes.js';
import { RailRecord } from './RailRecord.js';

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
  const recs = useRef(new Map<string, HTMLElement>());
  const focused = useRef<string>(undefined);
  const [said, setSaid] = useState('');
  const [edges, setEdges] = useState({ left: false, right: false });

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
  const springs = useRailSprings({
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
    onMove: move,
  });
  const { anims, held, landed } = springs;

  useLayoutEffect(() => {
    const node = box.current!;
    const measure = () => setDims({ w: node.clientWidth, h: node.clientHeight });
    const observer = new ResizeObserver(measure);

    measure();
    observer.observe(node);

    return () => observer.disconnect();
  }, []);

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

      springs.land(id);
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
  const standing = [...anims.entries()]
    .filter(([, anim]) => !anim.leaving)
    .sort(([, a], [, b]) => a.pos.x - b.pos.x)
    .map(([id, { row, pos }]) => ({ id, row, pos: pos.x }));
  const view = Math.max(0, dims.w - GUTTER);
  const width = Math.max(view, PAD * 2 + (count + (hole === undefined ? 0 : 1)) * step);

  return (
    <div className={`rail-area${locked ? ' locked' : ''}`} ref={box}>
      {dims.w > 0 && (
        <>
          <RailGutter shelf={shelf} scale={scale} />
          <div className="rail-line" style={{ top: shelf.rail }} />
          <div
            className={`rail-scroll${edges.left ? ' more-left' : ''}${edges.right ? ' more-right' : ''}`}
            ref={scroller}
            onScroll={(e) => {
              edge(e.currentTarget);
              springs.render();
            }}
            onWheel={(e) => {
              if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
            }}
          >
            <div className="rail-content" style={{ width }}>
              <RailLanes
                standing={standing}
                shelf={shelf}
                scale={scale}
                step={step}
                width={width}
                height={dims.h}
                scrolled={scroller.current?.scrollLeft ?? 0}
                view={view}
                held={held?.id}
                landed={landed}
                hole={hole}
              />
              <div className="recs" role="list" aria-label="Draft order">
                {[...ids, ...[...anims.keys()].filter((id) => !ids.includes(id))].map((id) => {
                  const anim = anims.get(id);

                  if (!anim) return null;

                  const index = ids.indexOf(id);

                  return (
                    <RailRecord
                      key={id}
                      anim={anim}
                      index={index}
                      count={count}
                      step={step}
                      shelf={shelf}
                      reduced={reduced}
                      locked={locked}
                      selected={selected.has(id)}
                      heldDy={held?.id === id ? held.dy : undefined}
                      setNode={(node) => {
                        if (node) recs.current.set(id, node);
                        else recs.current.delete(id);
                      }}
                      onPress={(e) => springs.press(e, id)}
                      onPointerMove={springs.moveTo}
                      onRelease={springs.release}
                      onKeyDown={(e) => key(e, id)}
                      onFocus={() => {
                        focused.current = id;
                        reveal(index);
                      }}
                      onBlur={() => (focused.current = undefined)}
                      onRemove={() => onRemove(id)}
                    />
                  );
                })}
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
