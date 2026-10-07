// Plain-language explainers: hover or focus a term, a join or a value and a
// small card says what it means. One card at a time, owned by the provider.
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type Explanation = { title: string; side?: string; body: ReactNode };

type Show = (content: Explanation | undefined, anchor?: HTMLElement, now?: boolean) => void;

const ExplainContext = createContext<Show>(() => {});

// Long enough that sweeping the pointer across the rail doesn't flash cards.
const HOVER_DELAY = 140;

export function ExplainProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<{ content: Explanation; anchor: HTMLElement }>();
  const timer = useRef<number>(undefined);
  const card = useRef<HTMLDivElement>(null);

  const show = useRef<Show>((content, anchor, now) => {
    clearTimeout(timer.current);

    if (!content || !anchor) return setShown(undefined);

    if (now) setShown({ content, anchor });
    else timer.current = window.setTimeout(() => setShown({ content, anchor }), HOVER_DELAY);
  }).current;

  // A press anywhere means hands are busy: dragging, clicking, typing.
  useLayoutEffect(() => {
    const hide = () => show(undefined);

    document.addEventListener('pointerdown', hide);

    return () => document.removeEventListener('pointerdown', hide);
  }, [show]);

  // Below the anchor, flipped above when it would leave the window.
  useLayoutEffect(() => {
    const node = card.current;

    if (!shown || !node) return;

    const r = shown.anchor.getBoundingClientRect();
    const x = Math.min(
      Math.max(8, r.left + r.width / 2 - node.offsetWidth / 2),
      innerWidth - node.offsetWidth - 8,
    );
    let y = r.bottom + 10;

    if (y + node.offsetHeight > innerHeight - 8) y = r.top - node.offsetHeight - 10;

    node.style.transform = `translate(${Math.round(x)}px, ${Math.round(Math.max(8, y))}px)`;
    node.classList.add('on');

    // Screen readers announce the card as the anchor's description while it is open.
    shown.anchor.setAttribute('aria-describedby', 'explain-tip');

    return () => shown.anchor.removeAttribute('aria-describedby');
  }, [shown]);

  return (
    <ExplainContext.Provider value={show}>
      {children}
      {shown && (
        <div className="tip" ref={card} role="tooltip" id="explain-tip">
          <div className="tip-head">
            <b>{shown.content.title}</b>
            {shown.content.side && <span className="mono">{shown.content.side}</span>}
          </div>
          {shown.content.body}
        </div>
      )}
    </ExplainContext.Provider>
  );
}

/** Handlers that open `explain()` on hover after a beat, or at once on keyboard focus. */
export function useExplain(explain: () => Explanation | undefined) {
  const show = useContext(ExplainContext);

  return {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) =>
      e.buttons === 0 && show(explain(), e.currentTarget),
    onPointerLeave: () => show(undefined),
    onFocus: (e: React.FocusEvent<HTMLElement>) =>
      e.currentTarget.matches(':focus-visible') && show(explain(), e.currentTarget, true),
    onBlur: () => show(undefined),
  };
}

export type TermName = keyof typeof TERMS;

/** A word with a dotted underline that explains itself. */
export function Term({ name, children }: { name: TermName; children: ReactNode }) {
  const handlers = useExplain(() => TERMS[name]);

  return (
    <button type="button" className="term" {...handlers}>
      {children}
    </button>
  );
}

function KickFigure() {
  return (
    <figure className="tip-fig">
      <svg viewBox="0 0 260 30" aria-hidden="true">
        <line className="fig-base" x1="10" y1="22" x2="250" y2="22" />
        {Array.from({ length: 8 }, (_, i) => (
          <rect
            key={i}
            className={i % 4 ? 'fig-kick' : 'fig-kick strong'}
            x={9 + i * 30}
            y="4"
            width="2"
            height="14"
          />
        ))}
      </svg>
      <figcaption>120 BPM is two beats a second</figcaption>
    </figure>
  );
}

function WheelFigure() {
  const at = (n: number, r: number): [number, number] => [
    130 + r * Math.sin((n % 12) * (Math.PI / 6)),
    70 - r * Math.cos((n % 12) * (Math.PI / 6)),
  ];

  return (
    <figure className="tip-fig">
      <svg viewBox="0 0 260 140" aria-hidden="true">
        <circle className="fig-ring" cx="130" cy="70" r="67" />
        <circle className="fig-ring" cx="130" cy="70" r="45" />
        <circle className="fig-ring" cx="130" cy="70" r="23" />
        {Array.from({ length: 12 }, (_, i) => {
          const n = i + 1;
          const [bx, by] = at(n, 56);
          const [ax, ay] = at(n, 34);
          // 8A and the three positions next to it on the wheel.
          const near = n === 7 || n === 9;

          return (
            <g key={n}>
              <text className={n === 8 ? 'fig-num on' : 'fig-num'} x={bx} y={by + 3}>
                {n}B
              </text>
              <text
                className={n === 8 ? 'fig-num uv' : near ? 'fig-num on' : 'fig-num'}
                x={ax}
                y={ay + 3}
              >
                {n}A
              </text>
            </g>
          );
        })}
        <text className="fig-note" x="0" y="20">
          8A sits next to
        </text>
        <text className="fig-note on" x="0" y="33">
          7A, 9A and 8B
        </text>
        <text className="fig-note end" x="260" y="20">
          outer: B major
        </text>
        <text className="fig-note end" x="260" y="33">
          inner: A minor
        </text>
      </svg>
    </figure>
  );
}

const TERMS = {
  bpm: {
    title: 'Tempo, in BPM',
    body: (
      <>
        <KickFigure />
        <p>Beats per minute: the pulse you would tap your foot to.</p>
      </>
    ),
  },
  key: {
    title: 'Key',
    body: <p>The set of notes a track uses. Nearby keys on the wheel share most of their notes.</p>,
  },
  camelot: {
    title: 'Key wheel',
    body: (
      <>
        <WheelFigure />
        <p>Every key as a spot on a clock. Neighbouring spots share most of their notes.</p>
      </>
    ),
  },
  major: {
    title: 'B: major keys',
    body: <p>The outer ring of the key wheel. Major keys tend to sound brighter.</p>,
  },
  minor: {
    title: 'A: minor keys',
    body: <p>The inner ring of the key wheel. Minor keys tend to sound darker.</p>,
  },
  join: {
    title: 'The joins',
    body: <p>How tempo and key change from one track to the next.</p>,
  },
  provisional: {
    title: 'Provisional',
    body: <p>Key detection is still being tested. Treat this one as a hint.</p>,
  },
  missing: {
    title: 'Not measured',
    body: <p>No reliable reading yet, so it is left blank rather than guessed.</p>,
  },
  time: {
    title: 'Set time',
    body: <p>When each track starts. A + means some lengths are unknown.</p>,
  },
} satisfies Record<string, Explanation>;
