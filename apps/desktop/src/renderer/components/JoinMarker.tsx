// The marker in each gap: the tempo step and how the two keys sit on the
// wheel, with a tiny wheel drawn between them. Hover or focus explains it.
import { useEffect, useRef } from 'react';
import { join } from '../joins.js';
import { parseCamelot } from '@selecta/core/domain/harmonic.js';
import type { Row } from '../state.js';
import { useExplain } from './Explain.js';

/** Where a wheel position sits on a 24px clock: B on the outer ring, A inside. */
function clock(camelot: string | undefined): [number, number] | undefined {
  const position = parseCamelot(camelot);

  if (!position) return;

  const angle = ((position.number % 12) / 12) * Math.PI * 2 - Math.PI / 2;
  const r = position.mode === 'B' ? 9.4 : 5.4;

  return [12 + Math.cos(angle) * r, 12 + Math.sin(angle) * r];
}

function Glyph({ from, to }: { from?: string; to?: string }) {
  const a = clock(from);
  const b = clock(to);

  if (!a || !b)
    return (
      <svg className="glyph" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="unknown" cx="12" cy="12" r="9" />
      </svg>
    );

  return (
    <svg className="glyph" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="outer" cx="12" cy="12" r="9.4" />
      <circle className="inner" cx="12" cy="12" r="5.4" />
      <path
        className="route"
        d={`M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`}
      />
      <circle className="dot" cx={b[0].toFixed(1)} cy={b[1].toFixed(1)} r="2.4" />
    </svg>
  );
}

const bpmOf = (row: Row) => (row.bpm === undefined ? 'not measured' : String(Math.round(row.bpm)));

export function JoinMarker({
  from,
  to,
  position,
  x,
  y,
  rail,
  width,
  hot,
  words,
  tempo,
  flashAt,
}: {
  from: Row;
  to: Row;
  position: number; // 1-based index of `to`
  x: number;
  y: number;
  rail: number;
  width: number;
  hot: boolean;
  words: number; // opacity of the relation words, which go first when the gap is squeezed
  tempo: number; // opacity of the glyph and tempo step
  flashAt?: number;
}) {
  const facts = join(from, to);
  const flash = useRef<HTMLSpanElement>(null);
  const explain = useExplain(() =>
    hot
      ? undefined
      : {
          title: 'The join',
          side: `${position} → ${position + 1}`,
          body: (
            <>
              <p>
                {from.title ?? 'Untitled'} into {to.title ?? 'Untitled'}
              </p>
              <dl>
                <dt>tempo</dt>
                <dd>
                  {facts.tempo} · {bpmOf(from)} → {bpmOf(to)}
                </dd>
                <dt>key</dt>
                <dd>
                  {facts.words} · {from.camelot ?? 'not measured'} → {to.camelot ?? 'not measured'}
                </dd>
              </dl>
              {facts.provisional && (
                <p className="tip-note">Rests on a key reading that is still provisional.</p>
              )}
              <p className="tip-note">Geometry only, never a verdict.</p>
            </>
          ),
        },
  );

  useEffect(() => {
    if (flashAt !== undefined)
      flash.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 900,
        easing: 'ease-out',
      });
  }, [flashAt]);

  return (
    <>
      <span
        className={`join-dot${hot ? ' hot' : ''}`}
        style={{ transform: `translate(${x.toFixed(1)}px, ${rail}px) rotate(45deg)` }}
      />
      <button
        type="button"
        className={`join${hot ? ' hot' : ''}`}
        style={{ width, transform: `translate(${(x - width / 2).toFixed(1)}px, ${y}px)` }}
        aria-label={`Join ${position} to ${position + 1}: ${from.title ?? 'Untitled'} into ${to.title ?? 'Untitled'}. ${facts.tempo}, ${facts.words.toLowerCase()}.`}
        {...explain}
      >
        <span className="join-flash" ref={flash} />
        <span className="join-tempo" style={{ opacity: tempo }}>
          <Glyph from={facts.from} to={facts.to} />
          {facts.tempo}
        </span>
        <span className="join-words" style={{ opacity: words }}>
          {facts.words}
        </span>
      </button>
    </>
  );
}
