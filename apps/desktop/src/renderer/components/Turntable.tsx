// Listening mode's background: the draft as one side of a record, centred on
// the sleeve and running out past the window, lit in the sleeve's colours. It
// turns at the record's tempo, winds down on pause, and can be grabbed and flung.
import { useEffect, useRef, type PointerEvent, type RefObject } from 'react';
import { lay, type Band, type Ring } from '../groove.js';
import { useFrameLoop } from '../hooks/motion.js';
import type { Palette } from '../palette.js';
import {
  coast,
  mix,
  nearing,
  rgbOf,
  swell,
  turnSpeed,
  unwrap,
  type Rgb,
  type Spin,
} from '../turntable.js';

const TAU = Math.PI * 2;
// The grooves start just past the sleeve's edge, so its corners sit over them.
const INNER = 1.12;
// The grooves' own cold light, for art with no colour worth lighting them in.
const COLD: Rgb = [200, 215, 255];
// The next record's band starts warming this many seconds before the end.
const WARM_LEAD = 40;
// A new sleeve's colours fade across over about a second.
const FADE = 0.8;

type Mask = { key: string; canvas: HTMLCanvasElement; c: number; bands: Band[] };

export function Turntable({
  records,
  now,
  position,
  duration,
  playing,
  bpm,
  palette,
  sleeve,
  still,
}: {
  records: { id: string; seconds?: number }[];
  now: number;
  /** Seconds into the record Music is on, as last read. */
  position: number;
  duration?: number;
  playing: boolean;
  bpm?: number;
  palette?: Palette;
  /** The sleeve the record turns around. */
  sleeve: RefObject<HTMLElement | null>;
  still: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tint = useRef<HTMLCanvasElement>(undefined);
  const mask = useRef<Mask>(undefined);
  const drawn = useRef('');
  const spin = useRef<Spin>({ angle: 0, speed: 0, flung: false });
  const grab = useRef<{ id: number; at: number; t: number }>(undefined);
  const colours = useRef<[Rgb, Rgb]>([COLD, COLD]);
  // Music is read about once a second; the needle moves on smoothly between reads.
  const read = useRef({ position, at: performance.now() });
  const props = useRef({ records, now, duration, playing, bpm, palette, still });

  props.current = { records, now, duration, playing, bpm, palette, still };
  read.current = { position, at: performance.now() };

  const centre = () => {
    const a = box.current!.getBoundingClientRect();
    const b = sleeve.current?.getBoundingClientRect();

    return b
      ? { x: b.left - a.left + b.width / 2, y: b.top - a.top + b.height / 2, r: b.width / 2 }
      : { x: a.width / 2, y: a.height / 2, r: Math.min(a.width, a.height) / 5 };
  };

  const kick = useFrameLoop((dt) => {
    const el = canvas.current;

    if (!el) return false;

    const p = props.current;
    const w = el.clientWidth;
    const h = el.clientHeight;

    if (el.width !== w || el.height !== h) {
      el.width = w;
      el.height = h;
    }

    if (!w || !h) return true;

    if (!grab.current && !p.still)
      spin.current = coast(spin.current, dt, p.playing ? turnSpeed(p.bpm) : 0);

    const target: [Rgb, Rgb] = [
      (p.palette && rgbOf(p.palette.a)) ?? COLD,
      (p.palette && rgbOf(p.palette.b)) ?? COLD,
    ];
    const k = 1 - Math.exp(-dt / FADE);

    colours.current = [
      mix(colours.current[0], target[0], k),
      mix(colours.current[1], target[1], k),
    ];

    const at = Math.min(
      p.duration || Infinity,
      read.current.position + (p.playing ? (performance.now() - read.current.at) / 1000 : 0),
    );
    const { x, y, r } = centre();
    // Out to the window's farthest corner from the sleeve.
    const outer = Math.hypot(Math.max(x, w - x), Math.max(y, h - y)) + 4;
    const key = `${Math.round(outer)}:${Math.round(r)}:${p.records.map((d) => `${d.id}:${d.seconds ?? ''}`).join('|')}`;

    if (mask.current?.key !== key) mask.current = cutMask(key, outer, r, p.records);

    const frame = {
      w,
      h,
      x,
      y,
      angle: spin.current.angle,
      mask: mask.current,
      colours: colours.current.map((c) => c.map(Math.round)) as [Rgb, Rgb],
      now: p.now,
      progress: p.duration ? Math.min(1, at / p.duration) : undefined,
      swell: p.playing && !p.still ? swell(at, p.bpm) : 0,
      warm: nearing(at, p.duration, WARM_LEAD),
    };
    // A paused record that has settled draws nothing new, so it costs nothing to leave open.
    const seen = JSON.stringify({ ...frame, mask: frame.mask.key });

    if (seen !== drawn.current) {
      drawn.current = seen;
      tint.current ??= document.createElement('canvas');
      paint(el.getContext('2d')!, tint.current, frame);
    }

    return true;
  });

  useEffect(kick, [kick]);

  const angleAt = (e: PointerEvent) => {
    const a = box.current!.getBoundingClientRect();
    const { x, y } = centre();

    return Math.atan2(e.clientY - a.top - y, e.clientX - a.left - x);
  };

  return (
    <div
      ref={box}
      className="tt"
      aria-hidden="true"
      onPointerDown={(e) => {
        if (e.button !== 0) return;

        e.currentTarget.setPointerCapture(e.pointerId);
        grab.current = { id: e.pointerId, at: angleAt(e), t: e.timeStamp };
        spin.current = { ...spin.current, speed: 0 };
        box.current!.classList.add('held');
      }}
      onPointerMove={(e) => {
        const held = grab.current;

        if (!held || held.id !== e.pointerId) return;

        const at = angleAt(e);
        const turned = unwrap(at - held.at);
        const dt = Math.max(0.008, (e.timeStamp - held.t) / 1000);

        spin.current = {
          angle: spin.current.angle + turned,
          // Smoothed, so the last jittery move before letting go doesn't decide the fling.
          speed: spin.current.speed * 0.5 + (turned / dt) * 0.5,
          flung: false,
        };
        grab.current = { id: held.id, at, t: e.timeStamp };
      }}
      onPointerUp={(e) => release(e.pointerId)}
      onPointerCancel={(e) => release(e.pointerId)}
    >
      <canvas ref={canvas} />
    </div>
  );

  function release(id: number) {
    if (grab.current?.id !== id) return;

    grab.current = undefined;
    spin.current = { ...spin.current, flung: true };
    box.current!.classList.remove('held');
  }
}

// The grooves drawn once in white, turned and tinted each frame. Each ring is broken into
// arcs of uneven shine, staggered so no seams line up, which is what shows it turning.
function cutMask(
  key: string,
  outer: number,
  r: number,
  records: { id: string; seconds?: number }[],
): Mask {
  const { bands, rings } = lay(outer, r * INNER, records);
  const size = Math.ceil(outer * 2) + 4;
  const c = size / 2;
  const canvas = document.createElement('canvas');

  canvas.width = canvas.height = size;

  const g = canvas.getContext('2d')!;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  rings.forEach(({ r: rr, loud }: Ring) => {
    const arcs = 18 + Math.floor(rnd() * 10);
    const start = rnd() * TAU;
    const phase = rnd() * TAU;

    g.lineWidth = 0.7 + loud * 0.5;

    for (let k = 0; k < arcs; k++) {
      const a0 = start + (k / arcs) * TAU;
      const shine = 0.55 + 0.4 * Math.sin(a0 * 2 + phase) ** 2 + 0.15 * rnd();

      g.strokeStyle = `rgba(255,255,255,${((0.18 + loud * 0.22) * shine).toFixed(3)})`;
      g.beginPath();
      g.arc(c, c, rr, a0, a0 + TAU / arcs);
      g.stroke();
    }
  });

  return { key, canvas, c, bands };
}

const css = ([r, g, b]: Rgb, a: number) =>
  `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;

function ring(g: CanvasRenderingContext2D, x: number, y: number, band: Band) {
  g.beginPath();
  g.arc(x, y, band.outer, 0, TAU);
  g.arc(x, y, Math.max(0, band.inner), 0, TAU, true);
}

function paint(
  ctx: CanvasRenderingContext2D,
  tint: HTMLCanvasElement,
  o: {
    w: number;
    h: number;
    x: number;
    y: number;
    angle: number;
    mask: Mask;
    colours: [Rgb, Rgb];
    now: number;
    progress?: number;
    swell: number;
    warm: number;
  },
) {
  const { w, h, x, y, mask, colours } = o;
  const { bands } = mask;
  const [a, b] = colours;
  const far = Math.max(w, h);

  if (tint.width !== w || tint.height !== h) {
    tint.width = w;
    tint.height = h;
  }

  // Ground: tokens.css --bg, with the sleeve's main colour glowing faintly behind it.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(0, 0, w, h);

  const glow = ctx.createRadialGradient(x, y, 0, x, y, far * 0.6);

  glow.addColorStop(0, css(a, 0.16 + o.swell * 0.05));
  glow.addColorStop(1, css(a, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // The grooves turned and tinted, fading toward the window's edges.
  const tg = tint.getContext('2d')!;

  tg.globalCompositeOperation = 'source-over';
  tg.clearRect(0, 0, w, h);
  tg.save();
  tg.translate(x, y);
  tg.rotate(o.angle);
  tg.drawImage(mask.canvas, -mask.c, -mask.c);
  tg.restore();
  tg.globalCompositeOperation = 'source-in';

  const across = tg.createLinearGradient(0, 0, w, h);

  across.addColorStop(0, css(a, 1));
  across.addColorStop(1, css(b, 1));
  tg.fillStyle = across;
  tg.fillRect(0, 0, w, h);
  tg.globalCompositeOperation = 'destination-in';

  const fall = tg.createRadialGradient(x, y, 0, x, y, far * 0.75);

  fall.addColorStop(0, 'rgba(0,0,0,0.8)');
  fall.addColorStop(1, 'rgba(0,0,0,0.25)');
  tg.fillStyle = fall;
  tg.fillRect(0, 0, w, h);
  // Records already played sit dimmer, like the worn part of a side.
  tg.globalCompositeOperation = 'destination-out';
  tg.fillStyle = 'rgba(0,0,0,0.55)';

  for (let i = 0; i < o.now && i < bands.length; i++) {
    ring(tg, x, y, bands[i]!);
    tg.fill('evenodd');
  }

  ctx.drawImage(tint, 0, 0);

  // The playing record's band lit, swelling once a bar; the next warming as its turn nears.
  ctx.globalCompositeOperation = 'lighter';

  const lit = (i: number, alpha: number) => {
    const band = bands[i];

    if (!band || alpha <= 0) return;

    ctx.save();
    ring(ctx, x, y, band);
    ctx.clip('evenodd');
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(tint, 0, 0);
    ctx.drawImage(tint, 0, 0);
    ctx.restore();
  };

  lit(o.now, 1);
  lit(o.now, o.swell * 0.6);
  lit(o.now + 1, o.warm * 0.8);

  // One lamp's sheen, fixed in the room while the record turns under it.
  tg.globalCompositeOperation = 'destination-in';

  const sheen = tg.createConicGradient(-0.5, x, y);

  for (const [stop, alpha] of [
    [0, 0],
    [0.06, 1],
    [0.13, 0],
    [0.5, 0],
    [0.56, 0.8],
    [0.63, 0],
    [1, 0],
  ] as const)
    sheen.addColorStop(stop, `rgba(0,0,0,${alpha})`);

  tg.fillStyle = sheen;
  tg.fillRect(0, 0, w, h);
  ctx.drawImage(tint, 0, 0);
  ctx.drawImage(tint, 0, 0);

  // Where the needle is: a fine line inside the playing band, acid as everything happening now.
  const band = bands[o.now];

  if (band && o.progress !== undefined) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    ctx.arc(x, y, band.outer - (band.outer - band.inner) * o.progress, 0, TAU);
    ctx.strokeStyle = 'rgba(214,255,58,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  const edge = ctx.createRadialGradient(w / 2, h / 2, far * 0.2, w / 2, h / 2, far * 0.75);

  edge.addColorStop(0, 'rgba(0,0,0,0)');
  edge.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, h);
}
