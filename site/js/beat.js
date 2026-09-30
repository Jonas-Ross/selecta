// Where the kicks are. The engine's beat phase can land on an offbeat hat, so the page
// lines its metronome and beat lights up with kick onsets found in the lows instead.

// 2.5 ms columns: finer than a kick's attack, coarse enough to scan 30 s instantly.
const RATE = 400;

// Loudness below 200 Hz, where kicks live, normalised to the loudest column.
function lows(x, sr) {
  const a = Math.exp((-2 * Math.PI * 200) / sr);
  const per = sr / RATE;
  const cols = Math.floor(x.length / per);
  const out = new Float32Array(cols);
  let l1 = 0,
    l2 = 0,
    max = 1e-9;

  for (let c = 0; c < cols; c++) {
    const i0 = Math.floor(c * per),
      i1 = Math.floor((c + 1) * per);
    let sum = 0;

    for (let i = i0; i < i1; i++) {
      l1 = a * l1 + (1 - a) * x[i];
      l2 = a * l2 + (1 - a) * l1;
      sum += l2 * l2;
    }

    out[c] = Math.sqrt(sum / (i1 - i0));

    if (out[c] > max) max = out[c];
  }

  for (let c = 0; c < cols; c++) out[c] = Math.pow(out[c] / max, 0.8);

  return out;
}

// Columns where the lows rise fastest.
function onsets(low) {
  // 20 ms smoothing irons out the ripple a 50 Hz kick leaves in 2.5 ms columns;
  // 150 ms apart keeps one onset per kick, still faster than any beat.
  const box = Math.round(RATE * 0.02),
    lag = box,
    near = Math.round(RATE * 0.15);
  // The rise peaks this late after the onset.
  const late = Math.round((box + lag) / 2);
  const n = low.length,
    smooth = new Float32Array(n),
    rise = new Float32Array(n);
  let acc = 0,
    max = 1e-9;

  for (let i = 0; i < n; i++) {
    acc += low[i] - (i >= box ? low[i - box] : 0);
    smooth[i] = acc / box;
  }

  for (let i = lag; i < n; i++)
    max = Math.max(max, (rise[i] = Math.max(0, smooth[i] - smooth[i - lag])));

  const out = [];

  for (let i = 0; i < n; i++) {
    if (rise[i] / max < 0.35) continue;

    let top = true;

    for (let j = Math.max(0, i - near); j <= Math.min(n - 1, i + near) && top; j++)
      top = rise[j] < rise[i] || (rise[j] === rise[i] && j >= i);

    if (top) out.push(i - late);
  }

  return out;
}

// The first kick-aligned beat, in seconds from the track's start, of the window
// [start, end) in samples; `fallback` when the kicks share no phase at this period.
export function beatOrigin(x, sr, start, end, period, fallback) {
  const on = onsets(lows(x.subarray(start, end), sr));
  let sx = 0,
    sy = 0;

  for (const c of on) {
    const a = (2 * Math.PI * c) / RATE / period;

    sx += Math.cos(a);
    sy += Math.sin(a);
  }

  if (!on.length || Math.hypot(sx, sy) / on.length < 0.5) return fallback;

  const phase = (Math.atan2(sy, sx) / (2 * Math.PI)) * period;

  return start / sr + (((phase % period) + period) % period);
}
