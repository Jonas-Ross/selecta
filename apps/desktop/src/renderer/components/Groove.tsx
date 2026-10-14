// The background: the draft cut as one side of a record, with light drifting
// across the grooves and the playing record's band warm under the needle.
import { useEffect, useMemo, useRef, useState } from 'react';
import { cut, type Cut } from '../groove.js';
import { useReducedMotion } from '../hooks/motion.js';

export function Groove({
  records = [],
  now,
  playing = false,
  progress,
  fixed = false,
}: {
  records?: { id: string; seconds?: number }[];
  /** The band Music is on, when it's on this draft. */
  now?: number;
  playing?: boolean;
  /** How far through the record Music is, 0 to 1. */
  progress?: number;
  /** Pinned to the window rather than the section, for a page that scrolls. */
  fixed?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const lit = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<[number, number]>();
  const still = useReducedMotion();
  const key = records.map((r) => `${r.id}:${r.seconds ?? ''}`).join('|');
  const shape = useMemo(() => size && cut(size[0], size[1], records), [size, key]);

  useEffect(() => {
    const el = box.current!;
    const observer = new ResizeObserver(() => setSize([el.clientWidth, el.clientHeight]));

    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (shape && size) draw(shape, size, base.current!, lit.current!);
  }, [shape, size]);

  const band = shape && now !== undefined ? shape.bands[now] : undefined;
  const needle =
    band && progress !== undefined
      ? band.outer - (band.outer - band.inner) * Math.min(1, Math.max(0, progress))
      : undefined;

  return (
    <div
      ref={box}
      className={`groove${fixed ? ' fixed' : ''}${still ? ' still' : ''}`}
      aria-hidden="true"
    >
      <canvas ref={base} />
      <div className="groove-lit">
        <canvas ref={lit} />
        {shape && (
          <div
            className="groove-sheen"
            style={{
              left: shape.cx - shape.bands[0]!.outer,
              top: shape.cy - shape.bands[0]!.outer,
              width: shape.bands[0]!.outer * 2,
              height: shape.bands[0]!.outer * 2,
            }}
          />
        )}
      </div>
      {shape && band && (
        <svg width="100%" height="100%">
          {playing && (
            <circle
              className="groove-warm"
              cx={shape.cx}
              cy={shape.cy}
              r={(band.outer + band.inner) / 2}
              strokeWidth={band.outer - band.inner}
            />
          )}
          {needle !== undefined && (
            <circle className="groove-needle" cx={shape.cx} cy={shape.cy} r={needle} />
          )}
        </svg>
      )}
    </div>
  );
}

// Two passes of the same grooves: dim ones for the ground, bright ones the sheen lights.
function draw(
  shape: Cut,
  [width, height]: [number, number],
  base: HTMLCanvasElement,
  lit: HTMLCanvasElement,
) {
  const dpr = window.devicePixelRatio || 1;
  const passes = [
    { canvas: base, colour: (loud: number) => `rgba(150,170,210,${0.02 + loud * 0.035})` },
    { canvas: lit, colour: (loud: number) => `rgba(220,230,255,${0.22 + loud * 0.4})` },
  ];

  for (const { canvas, colour } of passes) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    const g = canvas.getContext('2d')!;

    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (canvas === lit) {
      // The lit pass multiplies with the sheen, so its ground is black.
      g.fillStyle = '#000';
      g.fillRect(0, 0, width, height);
    }

    for (const { r, loud } of shape.rings) {
      g.strokeStyle = colour(loud);
      g.lineWidth = 0.7 + loud * 0.5;
      g.beginPath();
      g.arc(shape.cx, shape.cy, r, Math.PI, 2 * Math.PI);
      g.stroke();
    }
  }
}
