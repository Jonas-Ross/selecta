// The toast stack: newest in front, the rest tucked behind it until the pointer or
// focus opens the stack out. Floats over its screen's corner, so nothing below moves.
import {
  type CSSProperties,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { toasts, useToasts, type Toast, type Tone } from '../toasts.js';

const GAP = 8;
// How far each toast behind the front one peeks out, and how many show at all.
const PEEK = 9;
const DEPTH = 3;

// Memoized: the draft screen re-renders on every playback tick, the stack only when it changes.
export const Toaster = memo(function Toaster() {
  const list = useToasts();
  const paused = useSyncExternalStore(toasts.subscribe, toasts.paused);
  const [open, setOpen] = useState(false);
  const [heights, setHeights] = useState<ReadonlyMap<number, number>>(new Map());
  const stack = useRef<HTMLElement>(null);

  // Each screen mounts its own stack, and its toasts go with it.
  useEffect(() => () => toasts.clearAll(), []);

  useLayoutEffect(() => {
    if (open) toasts.pause('reading');
    else toasts.resume('reading');
  }, [open]);

  const measured = useCallback(
    (id: number, height: number | undefined) =>
      setHeights((all) => {
        if (all.get(id) === height) return all;

        const next = new Map(all);

        if (height === undefined) next.delete(id);
        else next.set(id, height);

        return next;
      }),
    [],
  );

  const shown = [...list].reverse();
  const front = shown[0] && heights.get(shown[0].id);
  let offset = 0;

  if (!list.length && open) setOpen(false);

  return (
    <section
      ref={stack}
      className={open ? 'toasts open' : 'toasts'}
      aria-label="Notifications"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(stack.current?.matches(':focus-within') ?? false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget) && !e.currentTarget.matches(':hover'))
          setOpen(false);
      }}
    >
      <ol>
        {shown.map((toast, index) => {
          const y = open ? offset : index * PEEK;

          if (!toast.closing) offset += (heights.get(toast.id) ?? 0) + GAP;

          return (
            <Item
              key={toast.id}
              toast={toast}
              index={index}
              y={y}
              tucked={!open && index > 0}
              front={front}
              hidden={!open && index >= DEPTH}
              paused={paused}
              onHeight={measured}
            />
          );
        })}
      </ol>
    </section>
  );
});

const Item = memo(function Item({
  toast,
  index,
  y,
  tucked,
  front,
  hidden,
  paused,
  onHeight,
}: {
  toast: Toast;
  index: number;
  y: number;
  /** Behind the front toast, taking its height so only the edge shows. */
  tucked: boolean;
  front: number | undefined;
  hidden: boolean;
  /** The clocks have stopped, so the bar that shows time left stops with them. */
  paused: boolean;
  onHeight: (id: number, height: number | undefined) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const { id } = toast;

  useLayoutEffect(() => {
    const el = body.current!;
    const observer = new ResizeObserver(([entry]) =>
      onHeight(id, entry!.borderBoxSize[0]!.blockSize),
    );

    onHeight(id, el.offsetHeight);
    observer.observe(el);

    return () => {
      observer.disconnect();
      onHeight(id, undefined);
    };
  }, [id, onHeight]);

  const dismissible = toast.dismissible !== false;

  return (
    <li
      className={`toast ${toast.tone}${toast.closing ? ' closing' : ''}${tucked ? ' tucked' : ''}`}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      inert={toast.closing || hidden}
      style={
        {
          '--y': `${-y}px`,
          '--scale': tucked ? 1 - index * 0.04 : 1,
          height: tucked ? front : undefined,
          zIndex: 10 - index,
          opacity: hidden ? 0 : undefined,
        } as CSSProperties
      }
      onKeyDown={(e) => dismissible && e.key === 'Escape' && toasts.dismiss(id)}
    >
      <div ref={body} className="toast-body">
        <Glyph tone={toast.tone} />
        <p>
          {toast.text}
          {toast.count > 1 && <span className="toast-count mono">×{toast.count}</span>}
          {toast.code && <span className="toast-code mono">{toast.code}</span>}
        </p>
        {toast.action && (
          <button
            type="button"
            className="btn sm toast-action"
            onClick={() => {
              toast.action!.run();

              // A toast standing for a state stays until that state clears.
              if (dismissible) toasts.dismiss(id);
            }}
          >
            {toast.action.label}
          </button>
        )}
        {dismissible && (
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => toasts.dismiss(id)}
          >
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 2l6 6M8 2l-6 6" />
            </svg>
          </button>
        )}
        {toast.ttl !== null && !toast.closing && (
          <span
            key={`${toast.count}-${toast.text}`}
            className="toast-clock"
            style={{
              animationDuration: `${toast.ttl}ms`,
              animationPlayState: paused ? 'paused' : 'running',
            }}
          />
        )}
      </div>
    </li>
  );
});

function Glyph({ tone }: { tone: Tone }) {
  return (
    <svg className="toast-glyph" viewBox="0 0 16 16" aria-hidden="true">
      {tone === 'success' ? (
        <path d="M4 8.3l2.6 2.6L12 5.4" />
      ) : tone === 'info' ? (
        <>
          <path d="M8 7.2v4" />
          <circle cx="8" cy="4.8" r="0.4" />
        </>
      ) : (
        <>
          <path d="M8 4.2v4.6" />
          <circle cx="8" cy="11.4" r="0.4" />
        </>
      )}
    </svg>
  );
}
