// Records drawn on canvas, once per size or label change; spinning is a transform on top.
import { css } from './dom.js';
import { lcg } from './synth.js';

const records = new Map();
const TAU = Math.PI * 2;

function ringText(g, text, r, size) {
  g.font = `500 ${size}px "DM Mono", monospace`;
  let line = text;

  while (g.measureText(line).width < TAU * r * 0.8) line += text;

  const chars = [...line];
  const widths = chars.map((c) => g.measureText(c).width);
  const stretch = (TAU * r) / widths.reduce((a, b) => a + b, 0);
  let a = -Math.PI / 2;

  chars.forEach((c, i) => {
    const w = (widths[i] * stretch) / r;

    g.save();
    g.rotate(a + w / 2 + Math.PI / 2);
    g.fillText(c, 0, -r);
    g.restore();
    a += w;
  });
}

const titleFont = (px) => `800 ${px}px "Hubot Sans", "Arial Black", sans-serif`;

// Wraps a title onto at most two lines, shrinking it until it fits; leaves g.font set to match.
function fitLines(g, text, maxW, size) {
  for (let s = size; s > size * 0.4; s *= 0.92) {
    g.font = titleFont(s);
    const lines = [];

    for (const w of text.split(/\s+/)) {
      const last = lines.length - 1;

      if (last >= 0 && g.measureText(`${lines[last]} ${w}`).width <= maxW) lines[last] += ` ${w}`;
      else lines.push(w);
    }

    if (lines.length <= 2 && lines.every((l) => g.measureText(l).width <= maxW))
      return { lines, size: s };
  }

  const s = size * 0.4;

  g.font = titleFont(s);
  let t = text;

  while (t.length > 1 && g.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);

  return { lines: [`${t.trimEnd()}…`], size: s };
}

function drawRecord(canvas, o) {
  // offsetWidth ignores the spin and intro transforms, which would inflate a bounding box.
  const w = canvas.offsetWidth;

  if (!w) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const S = Math.round(w * dpr);

  if (canvas.width !== S) canvas.width = canvas.height = S;

  const g = canvas.getContext('2d');
  const R = S / 2;

  g.setTransform(1, 0, 0, 1, R, R);
  g.clearRect(-R, -R, S, S);

  g.fillStyle = '#0d0d10';
  g.beginPath();
  g.arc(0, 0, R * 0.995, 0, TAU);
  g.fill();

  const rand = lcg(o.seed ?? 11);
  // Smooth bands between tracks, as on a pressed LP.
  const gaps = [0.5, 0.61, 0.72, 0.84];

  g.lineWidth = Math.max(1, dpr * 0.7);

  for (let r = R * 0.37; r < R * 0.965; r += 1.7 * dpr) {
    if (gaps.some((x) => Math.abs(r / R - x) < 0.01)) continue;

    g.strokeStyle = `rgba(255,255,255,${(0.03 + rand() * 0.05).toFixed(3)})`;
    g.beginPath();
    g.arc(0, 0, r, 0, TAU);
    g.stroke();
  }

  g.strokeStyle = 'rgba(255,255,255,0.16)';
  g.lineWidth = 1.2 * dpr;
  g.beginPath();
  g.arc(0, 0, R * 0.985, 0, TAU);
  g.stroke();

  const L = R * 0.34;

  g.fillStyle = o.label;
  g.beginPath();
  g.arc(0, 0, L, 0, TAU);
  g.fill();
  g.fillStyle = o.ink;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  ringText(g, o.ring, L * 0.84, R * 0.034);

  const t = fitLines(g, o.title, L * 1.3, R * 0.09);
  const lh = t.size * 1.02;
  const top = -R * 0.07 - ((t.lines.length - 1) * lh) / 2;

  t.lines.forEach((l, i) => g.fillText(l, 0, top + i * lh));

  if (o.sub) {
    g.font = `500 ${R * 0.042}px "DM Mono", monospace`;
    g.fillText(o.sub, 0, R * 0.125);
  }

  g.fillStyle = '#08080a';
  g.beginPath();
  g.arc(0, 0, R * 0.024, 0, TAU);
  g.fill();
}

const onResize = new ResizeObserver((entries) =>
  entries.forEach((e) => drawRecord(e.target, records.get(e.target))),
);

// Merges opts into the canvas's record and redraws it; later calls change only what they pass.
export function record(canvas, opts) {
  if (!records.has(canvas)) onResize.observe(canvas);

  const o = Object.assign(records.get(canvas) ?? {}, opts);

  records.set(canvas, o);
  drawRecord(canvas, o);
}

export const redrawRecords = () => records.forEach((o, c) => drawRecord(c, o));

// Label colours, as the CSS tokens `--<name>` for the paper and `--on-<name>` for the ink.
export const label = (name) => ({ label: css(`--${name}`), ink: css(`--on-${name}`) });
