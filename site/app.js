import { synthLoop, lcg, LOOP } from './synth.js';
import { beatOrigin } from './beat.js';

const SR = 44100;
// metrognome is tuned and validated on 30-second preview clips.
const WINDOW_SECS = 30;
// 33⅓ rpm, the speed a record really turns at.
const TURN_SECS = 1.8;
// Parked records drift instead of stopping, so the page never looks frozen.
const IDLE_RATE = 0.22;
// Faster than 33⅓ while the engine listens, so waiting looks like work.
const LISTEN_RATE = 1.8;
// Tonearm swing that sets the stylus in the outer grooves, about its pivot.
const ARM_PLAY = 18;
const ARM_PIVOT = '108 6';
// Lights around the demo record: four bars of four beats.
const RING = 16;
const NOTES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const LOOP_TITLE = 'Built-in loop';
const DECK_RING = 'MEASURED IN THIS TAB · NOTHING UPLOADED · ';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const G = window.gsap;
const motion = !!G && !reduceMotion;

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);

  n.append(...kids);

  return n;
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---- engine -----------------------------------------------------------------

let worker = null;
let nextId = 0;
const waiting = new Map();

function engine() {
  if (!worker) {
    worker = new Worker(new URL('worker.js', import.meta.url));

    worker.onmessage = ({ data }) => {
      const w = waiting.get(data.id);

      waiting.delete(data.id);

      if (data.ok) w.resolve(data);
      else w.reject(new Error(data.error));
    };

    worker.onerror = (e) => {
      for (const w of waiting.values())
        w.reject(new Error(e.message || 'The analysis engine failed to load.'));

      waiting.clear();
    };
  }

  return worker;
}

function analyze(samples) {
  const id = nextId++;
  const copy = samples.slice();

  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    engine().postMessage({ id, samples: copy, sampleRate: SR }, [copy.buffer]);
  });
}

async function decodeFile(file) {
  const bytes = await file.arrayBuffer();
  // decodeAudioData resamples to the context's rate, so everything reaches the
  // engine at 44.1 kHz whatever the file was.
  const buf = await new OfflineAudioContext(1, 1, SR).decodeAudioData(bytes);
  const mono = new Float32Array(buf.length);

  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);

    for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
  }

  return mono;
}

// The middle of a long track is where it is most itself: past the intro, before the outro.
function headline(len) {
  const w = WINDOW_SECS * SR;

  if (len <= w) return { start: 0, end: len, long: false };

  const start = Math.floor((len - w) / 2);

  return { start, end: start + w, long: true };
}

// ---- keys ---------------------------------------------------------------------

const majorPc = (n) => ((((n - 8) * 7) % 12) + 12) % 12;
const camelotName = (n, ring) =>
  ring === 'B' ? `${NOTES[majorPc(n)]} major` : `${NOTES[(majorPc(n) + 9) % 12]} minor`;
const parseCamelot = (c) => ({ n: parseInt(c, 10), ring: c.slice(-1) });
const wheelStep = (n, d) => ((((n - 1 + d) % 12) + 12) % 12) + 1;

// ---- records ----------------------------------------------------------------------

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

const titleFont = (px) => `800 ${px}px Unbounded, "Arial Black", sans-serif`;

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

// A record drawn once per size or label change; spinning is a transform on top.
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

function record(canvas, opts) {
  if (!records.has(canvas)) onResize.observe(canvas);

  const o = Object.assign(records.get(canvas) ?? {}, opts);

  records.set(canvas, o);
  drawRecord(canvas, o);
}

const redrawRecords = () => records.forEach((o, c) => drawRecord(c, o));

// Endless motion pauses while its element is off screen, so the page goes idle as it's read.
const watchers = new Map();
const onScreen = new IntersectionObserver((entries) =>
  entries.forEach((e) => watchers.get(e.target)(e.isIntersecting)),
);

function whileSeen(node, fn) {
  watchers.set(node, fn);
  onScreen.observe(node);
}

// Turns a record at 33⅓ with a speed knob, so it can drift, spin up and wind down.
class Spinner {
  constructor(node) {
    this.node = node;
    this.rate = 0;
    this.tw = null;
    this.seen = true;
    whileSeen(node, (on) => {
      this.seen = on;
      this.tw?.paused(!on);
    });
  }
  make() {
    if (!motion) return;

    const r = G.getProperty(this.node, 'rotation');

    this.tw?.kill();
    this.tw = G.fromTo(
      this.node,
      { rotation: r },
      { rotation: r + 360, duration: TURN_SECS, ease: 'none', repeat: -1 },
    );
    this.tw.timeScale(Math.max(this.rate, 0.001)).paused(!this.seen);
  }
  speed(rate, secs = 0.8) {
    this.rate = rate;

    if (!motion) return;

    if (!this.tw) this.make();

    G.to(this.tw, {
      timeScale: Math.max(rate, 0.001),
      duration: secs,
      ease: 'power2.inOut',
      overwrite: true,
    });
  }
}

// ---- beat pulse ---------------------------------------------------------------------

// Things that move on the beat use the Web Animations clock, so a pulse can be pinned
// to the moment the audio plays a kick rather than to whenever a frame happens to land.
const LEVELS = [
  { transform: 'scaleY(1)' },
  { transform: 'scaleY(0.35)', offset: 0.5 },
  { transform: 'scaleY(0.7)', offset: 0.75 },
  { transform: 'scaleY(0.3)' },
];
const hit = (peak, rest) => [
  { ...peak, easing: 'cubic-bezier(.2,.7,.3,1)' },
  { ...rest, offset: 0.4 },
  rest,
];
const liveDot = ['#live i', hit({ transform: 'scale(1.6)' }, { transform: 'scale(1)' }), 0];
// The level meter's bars run out of step so it reads as music, not a blink.
const meter = (sel) => [sel, LEVELS, (i) => (i * 0.23) % 1];
const PULSES = {
  idle: [liveDot],
  live: [
    liveDot,
    ['#sticker', hit({ transform: 'scale(1.08)' }, { transform: 'scale(1)' }), 0],
    [
      '.glow',
      hit({ opacity: 1, transform: 'scale(1.07)' }, { opacity: 0.6, transform: 'scale(1)' }),
      0,
    ],
    [
      '#hero-title .dot',
      hit(
        { transform: 'scale(1.45)', color: css('--acid') },
        { transform: 'scale(1)', color: css('--coral') },
      ),
      0,
    ],
    // Every other sleeve bounces on the offbeat.
    [
      '.float .sleeve',
      hit({ transform: 'translateY(-7%)' }, { transform: 'translateY(0)' }),
      (i) => (i % 2) / 2,
    ],
    meter('#hear .eq i'),
  ],
  groove: [meter('#g-hear .eq i')],
};
let pulses = [];

function pulse(mode, bpm, zero = document.timeline.currentTime) {
  for (const a of pulses) a.cancel();

  pulses = [];

  if (!mode || reduceMotion || !bpm) return;

  const beat = 60000 / bpm;

  for (const [sel, frames, shift] of PULSES[mode]) {
    $$(sel).forEach((node, i) => {
      const a = node.animate(frames, { duration: beat, iterations: Infinity });

      a.startTime = zero + beat * (typeof shift === 'function' ? shift(i) : shift);
      pulses.push(a);
    });
  }
}

// ---- audio ---------------------------------------------------------------------------

let player = null;
// How long a sample takes from the context's clock to the speakers.
const latency = (ctx) => ctx.outputLatency || ctx.baseLatency || 0;
// When audio scheduled at context time t leaves the speakers, on the page's clock.
const perfAt = (ctx, t) => performance.now() + (t - ctx.currentTime + latency(ctx)) * 1000;

// Built once per track and reused by every play, whichever context plays it.
function toBuffer(samples) {
  const buf = new AudioBuffer({ length: samples.length, numberOfChannels: 1, sampleRate: SR });

  buf.copyToChannel(samples, 0);

  return buf;
}

function playBuffer(ctx, buffer, at, loop = false) {
  const src = new AudioBufferSourceNode(ctx, { buffer, loop });

  src.connect(ctx.destination);
  src.start(at);

  return src;
}

function stopAll() {
  if (!player) return;

  const { ctx, raf, kind } = player;

  player = null;

  if (raf) cancelAnimationFrame(raf);

  ctx.close();

  if (kind === 'hero') heroIdle();
  else if (kind === 'groove') grooveIdle();
  else deckIdle();
}

// ---- hero ---------------------------------------------------------------------------------

engine(); // Fetch and compile the engine while the loop is synthesized.
const loopSamples = synthLoop(SR);
const loopHead = headline(loopSamples.length);
const loopReading = analyze(loopSamples.subarray(loopHead.start, loopHead.end));
let heroBpm = 0;
let heroBuffer = null;
const heroSpin = new Spinner(document.querySelector('#platter .spin'));

function arm(deg, secs) {
  const g = $('arm-g');

  if (motion)
    G.to(g, {
      rotation: deg,
      svgOrigin: ARM_PIVOT,
      duration: secs,
      ease: 'power2.inOut',
      overwrite: true,
    });
  else g.setAttribute('transform', `rotate(${deg} ${ARM_PIVOT})`);
}

function heroIdle() {
  $('hear').setAttribute('aria-pressed', 'false');
  $('hear-label').textContent = 'Hear the beat';
  heroSpin.speed(IDLE_RATE, 1.2);
  arm(0, 0.7);
  pulse('idle', heroBpm);
}

function playHero() {
  stopAll();
  const ctx = new AudioContext();
  // Loop whole bars only, so the beat never stumbles at the seam.
  const bar = (4 * 60) / LOOP.bpm;

  heroBuffer ??= toBuffer(
    loopSamples.subarray(0, Math.round(Math.floor(LOOP.secs / bar) * bar * SR)),
  );
  // The needle drops first, then the music starts.
  const t0 = ctx.currentTime + (motion ? 0.5 : 0.05);

  playBuffer(ctx, heroBuffer, t0, true);
  player = { ctx, kind: 'hero' };
  $('hear').setAttribute('aria-pressed', 'true');
  $('hear-label').textContent = 'Stop';
  arm(ARM_PLAY, 0.45);
  heroSpin.speed(1, 0.5);
  pulse('live', LOOP.bpm, perfAt(ctx, t0));
}

function heroReady({ report }) {
  const { tempo, key } = report.features;

  heroBpm = tempo && !tempo.uncertain ? tempo.bpm : 0;
  $('live').classList.add('ready');
  $('live-text').textContent = 'Engine live in this tab';
  countTo($('st-bpm'), tempo?.bpm, (v) => Math.round(v), 1.4);
  $('st-key').textContent = keyText(key);

  if (!player) pulse('idle', heroBpm);

  record($('hero-vinyl'), { sub: discSub(tempo, key) });
}

function heroFail() {
  $('live').classList.add('fail');
  $('live-text').textContent = "The engine didn't load in this browser";
  $('st-bpm').textContent = '--';
  $('st-key').textContent = 'no engine';
}

// Drag the hero record to scratch it; it spins back up when let go.
function scratchable(platter, spinner) {
  let last = null;
  const angle = (e) => {
    const b = platter.getBoundingClientRect();

    return (
      (Math.atan2(e.clientY - (b.top + b.height / 2), e.clientX - (b.left + b.width / 2)) * 180) /
      Math.PI
    );
  };

  platter.addEventListener('pointerdown', (e) => {
    if (e.button || !matchMedia('(pointer: fine)').matches) return;

    last = angle(e);
    spinner.tw?.pause();
    platter.setPointerCapture(e.pointerId);
    platter.classList.add('scratching');
  });
  platter.addEventListener('pointermove', (e) => {
    if (last == null) return;

    const a = angle(e);
    const d = ((a - last + 540) % 360) - 180;

    last = a;
    G.set(spinner.node, { rotation: `+=${d}` });
  });

  const end = () => {
    if (last == null) return;

    last = null;
    platter.classList.remove('scratching');
    spinner.make();
  };

  platter.addEventListener('pointerup', end);
  platter.addEventListener('pointercancel', end);
}

// ---- demo ------------------------------------------------------------------------------

const state = { title: '', loop: false, head: null, report: null, origin: 0, buffer: null, run: 0 };
const deckSpin = new Spinner(document.querySelector('#deck-disc .spin'));
// Label colours, as the CSS tokens `--<name>` for the paper and `--on-<name>` for the ink.
const LABELS = ['acid', 'coral', 'uv', 'teal', 'pink'];
const label = (name) => ({ label: css(`--${name}`), ink: css(`--on-${name}`) });

// The loop keeps the house colour; a dropped file gets one of the others, the same each time.
function deckLabel(title, loop) {
  if (loop) return label(LABELS[0]);

  let h = 0;

  for (const c of title) h = (h * 31 + c.charCodeAt(0)) >>> 0;

  return label(LABELS[1 + (h % (LABELS.length - 1))]);
}

const keyText = (key) => (key ? `${key.uncertain ? 'maybe ' : ''}${key.key}` : 'no key');
const discSub = (tempo, key) =>
  tempo
    ? `${tempo.uncertain ? '~' : ''}${Math.round(tempo.bpm)} BPM · ${key ? key.camelot : 'no key'}`
    : 'no beat';

function countTo(node, to, fmt, secs = 1, from = 0) {
  node._tw?.kill();

  if (to == null) return (node.textContent = '--');

  if (!motion) return (node.textContent = fmt(to));

  const o = { v: from };

  return (node._tw = G.to(o, {
    v: to,
    duration: secs,
    ease: 'power3.out',
    onUpdate: () => (node.textContent = fmt(o.v)),
  }));
}

// Spins the Camelot code round the wheel before it settles on the reading.
function rollCode(node, code) {
  const steps = 14;
  const n = code && parseCamelot(code).n;

  countTo(node, code && steps, (v) => {
    const k = Math.round(v);

    return k >= steps ? code : `${wheelStep(n, k - steps)}${k % 2 ? 'B' : 'A'}`;
  });
}

function reading(kind, est) {
  $(`${kind}-reading`).classList.toggle('guess', !!est?.uncertain);
  const conf = est?.confidence ?? 0;
  const meter = $(`${kind}-meter`);

  meter.firstElementChild.style.width = `${Math.round(Math.max(0, Math.min(1, conf)) * 100)}%`;
  meter.setAttribute(
    'aria-label',
    est
      ? `${kind === 'tempo' ? 'Tempo' : 'Key'} confidence ${conf.toFixed(2)} out of 1`
      : `No ${kind} measured`,
  );
  const sure = $(`${kind}-sure`);

  sure.replaceChildren();

  if (!est) return;

  if (est.uncertain) sure.append(el('span', { className: 'flag', textContent: 'a guess' }), ' · ');

  sure.append(`confidence ${conf.toFixed(2)}`);

  if (!est.uncertain)
    sure.append(
      ` · ${est.maturity === 'validated' ? 'tested on real tracks' : 'still being tested'}`,
    );
}

function blank(title, loop) {
  $('deck-title').textContent = title;
  $('bpm').textContent = '---';
  $('camelot').textContent = '--';
  $('keyname').textContent = 'key';
  reading('tempo', null);
  reading('key', null);
  $('wheel').hidden = true;
  $('said').textContent = 'Listening…';
  $('play').disabled = true;
  record($('deck-vinyl'), {
    ...deckLabel(title, loop),
    title,
    ring: DECK_RING,
    sub: 'listening…',
    seed: 9,
  });
}

function render(report, ms) {
  const { tempo, key } = report.features;

  countTo(
    $('bpm'),
    tempo?.bpm,
    tempo?.uncertain ? (v) => `~${Math.round(v)}` : (v) => v.toFixed(1),
  );
  rollCode($('camelot'), key?.camelot);
  $('keyname').textContent = keyText(key);
  reading('tempo', tempo);
  reading('key', key);

  const onWheel = key && !key.uncertain;

  $('wheel').hidden = !onWheel;

  if (onWheel) {
    const { n, ring } = parseCamelot(key.camelot);
    const other = ring === 'A' ? 'B' : 'A';
    const near = [
      [wheelStep(n, -1), ring],
      [wheelStep(n, 1), ring],
      [n, other],
    ];

    $('wheel-keys').replaceChildren(
      ...near.map(([m, r]) => {
        const chip = el(
          'span',
          { className: 'bk' },
          el('b', { textContent: `${m}${r}` }),
          camelotName(m, r),
        );

        chip.style.setProperty('--n', m);

        return chip;
      }),
    );
  }

  const said = [];

  if (!tempo) said.push('No steady beat to speak of.');
  else if (tempo.uncertain) said.push('No steady beat, so the tempo is a guess.');

  if (!key) said.push('Not enough notes to name a key.');
  else if (key.uncertain) said.push('The key is a guess.');

  const kept = [tempo && !tempo.uncertain && 'tempo', key && !key.uncertain && 'key'].filter(
    Boolean,
  );

  said.push(
    kept.length === 2
      ? 'Both are sure enough that Selecta would keep them.'
      : kept.length
        ? `Selecta would keep only the ${kept[0]}.`
        : 'Selecta would keep nothing from this rather than guess.',
  );

  if (state.loop)
    said.push(`This loop is built at ${LOOP.bpm} BPM in ${LOOP.key}, so you can check the answer.`);

  $('said').textContent = said.join(' ');

  status(
    `Measured ${state.head.long ? 'the middle 30 seconds' : 'it'} in ${Math.round(ms)} ms. Nothing left this tab.`,
  );
  $('build').textContent = `This is algorithm ${report.algorithm_version}.`;
  record($('deck-vinyl'), { sub: discSub(tempo, key) });
  $('play').disabled = false;
}

function fail(title, reason) {
  blank(title, false);
  $('said').textContent = reason;
  status('Nothing was measured.', true);
  record($('deck-vinyl'), { sub: 'nothing measured' });
}

function status(text, err = false) {
  $('status').textContent = text;
  $('status').classList.toggle('err', err);
}

async function load(samples, title, pending) {
  stopAll();
  const run = ++state.run;
  const loop = samples === loopSamples;
  const head = headline(samples.length);

  Object.assign(state, { title, loop, head, report: null, origin: 0, buffer: null });
  blank(title, loop);
  deckSpin.speed(LISTEN_RATE, 0.4);
  status(head.long ? 'Listening to the middle 30 seconds…' : 'Listening…');

  try {
    const { report, ms } = await (pending ??
      analyze(samples.subarray(state.head.start, state.head.end)));

    if (run !== state.run) return;

    const tempo = report.features.tempo;

    state.report = report;
    // Playback starts at the measured window, so nothing before it is kept.
    state.buffer = toBuffer(samples.subarray(head.start));

    if (tempo)
      state.origin = beatOrigin(
        samples,
        SR,
        head.start,
        head.end,
        60 / tempo.bpm,
        head.start / SR + tempo.beat_offset_secs,
      );

    deckSpin.speed(IDLE_RATE, 1);
    render(report, ms);
  } catch (err) {
    if (run !== state.run) return;

    deckSpin.speed(IDLE_RATE, 1);
    fail(title, `The engine could not measure this: ${err.message}`);
  }
}

async function takeFile(file) {
  if (!file) return;

  stopAll();
  const run = ++state.run;
  const name = file.name.replace(/\.[^.]+$/, '');

  status(`Decoding ${file.name}…`);
  deckSpin.speed(LISTEN_RATE, 0.4);

  try {
    const samples = await decodeFile(file);

    // Another file or the loop was picked while this one decoded.
    if (run !== state.run) return;

    if (samples.length < SR * 5) throw new Error('it is shorter than five seconds');

    await load(samples, name);
  } catch (err) {
    if (run !== state.run) return;

    deckSpin.speed(IDLE_RATE, 1);
    const why = /shorter than/.test(err.message) ? err.message : 'your browser cannot decode it';

    fail(name, `Could not read this file: ${why}. Try an MP3, AAC or WAV.`);
  }
}

function deckIdle() {
  $('play').classList.remove('on');
  $('play-label').textContent = 'Play with metronome';
  $$('#beats i').forEach((d) => d.classList.remove('on'));
  deckSpin.speed(IDLE_RATE, 1);
}

function playDeck() {
  stopAll();

  if (!state.report) return;

  const tempo = state.report.features.tempo;
  const ctx = new AudioContext();
  const t0 = ctx.currentTime + 0.15;

  playBuffer(ctx, state.buffer, t0).onended = () => player?.ctx === ctx && stopAll();

  // A guessed tempo gets no metronome: clicking along to a guess would claim a beat that isn't there.
  const period = tempo && !tempo.uncertain ? 60 / tempo.bpm : 0;
  const fromSec = state.head.start / SR;
  const origin = state.origin;
  let next = period ? origin + Math.ceil((fromSec - origin) / period - 1e-6) * period : Infinity;
  const click = (at) => {
    const o = ctx.createOscillator(),
      g = ctx.createGain();

    o.frequency.value = 1760;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.3, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    o.connect(g).connect(ctx.destination);
    o.start(at);
    o.stop(at + 0.06);
  };
  const dots = $$('#beats i');
  let lit = -1;

  player = { ctx, raf: 0, kind: 'deck' };

  const tick = () => {
    const now = ctx.currentTime;

    // Clicks are scheduled a little ahead so the audio clock, not the frame rate, keeps time.
    while (t0 + (next - fromSec) < now + 0.15) {
      click(t0 + (next - fromSec));
      next += period;
    }

    if (period && now >= t0) {
      const heard = fromSec + (now - t0) - latency(ctx);
      const b = Math.floor((heard - origin) / period + 1e-3);
      const i = ((b % RING) + RING) % RING;

      if (i !== lit) {
        dots[lit]?.classList.remove('on');
        dots[i].classList.add('on');
        lit = i;
      }
    }

    if (player?.ctx === ctx) player.raf = requestAnimationFrame(tick);
  };

  player.raf = requestAnimationFrame(tick);
  $('play').classList.add('on');
  $('play-label').textContent = 'Stop';
  deckSpin.speed(1, 0.5);
}

// ---- drum machine --------------------------------------------------------------------------

// One bar of sixteenth notes per genre, at a tempo typical of it. Illustrations, not measurements.
const GROOVES = [
  { name: 'Hip-hop', bpm: 90, kick: [0, 7, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
  { name: 'House', bpm: 124, kick: [0, 4, 8, 12], snare: [4, 12], hat: [2, 6, 10, 14] },
  { name: 'Garage', bpm: 132, kick: [0, 6, 10], snare: [4, 12], hat: [2, 3, 6, 10, 11, 14] },
  { name: 'Techno', bpm: 135, kick: [0, 4, 8, 12], snare: [4, 12], hat: [...Array(16).keys()] },
  { name: 'Dubstep', bpm: 140, kick: [0, 11], snare: [8], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
  {
    name: 'Drum & bass',
    bpm: 174,
    kick: [0, 10],
    snare: [4, 12],
    hat: [0, 2, 4, 6, 8, 10, 12, 14],
  },
];
const LANES = ['kick', 'snare', 'hat'];
const STEPS = 16;
// Unattended, the machine moves to the next genre at the first bar line after this long.
const AUTO_SECS = 5;
const groove = { i: 1, t0: 0, last: -1, auto: true, seen: false, raf: 0, pads: {}, marks: [] };

function buildMachine() {
  $('presets').append(
    ...GROOVES.map((g, i) => {
      const b = el('button', { type: 'button' }, `${g.name} `, el('small', { textContent: g.bpm }));

      b.setAttribute('aria-pressed', String(i === groove.i));
      b.addEventListener('click', () => setGroove(i, true));

      return b;
    }),
  );
  $('g-bpm').textContent = GROOVES[groove.i].bpm;
  $('g-name').textContent = GROOVES[groove.i].name;

  for (let s = 0; s < STEPS; s++)
    groove.marks.push(
      $('count-row').appendChild(el('i', { textContent: s % 4 ? '' : String(s / 4 + 1) })),
    );

  for (const lane of LANES) {
    groove.pads[lane] = [];

    for (let s = 0; s < STEPS; s++)
      groove.pads[lane].push(
        $('grid').appendChild(
          el('i', { className: `${lane}${Math.floor(s / 4) % 2 ? ' alt' : ''}` }, el('b')),
        ),
      );
  }

  paintPattern(false);
}

function paintPattern(animate) {
  const g = GROOVES[groove.i];
  const lit = [];

  for (const lane of LANES)
    groove.pads[lane].forEach((pad, s) => {
      const on = g[lane].includes(s);

      if (on && !pad.classList.contains('on')) lit.push(pad);

      pad.classList.toggle('on', on);
    });

  if (animate && motion && lit.length)
    G.fromTo(
      lit,
      { scale: 0.55 },
      { scale: 1, duration: 0.5, ease: 'back.out(3)', stagger: 0.012 },
    );
}

function setGroove(i, byHand) {
  const was = GROOVES[groove.i].bpm;

  groove.i = i;

  if (byHand) groove.auto = false;

  const g = GROOVES[i];

  [...$('presets').children].forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
  countTo($('g-bpm'), g.bpm, (v) => Math.round(v), 0.6, was);
  $('g-name').textContent = g.name;

  if (motion)
    G.fromTo(
      '#g-name',
      { yPercent: 70, autoAlpha: 0 },
      { yPercent: 0, autoAlpha: 1, duration: 0.45, ease: 'back.out(2)' },
    );

  paintPattern(true);
  groove.last = -1;
  groove.t0 = performance.now();

  if (player?.kind === 'groove') {
    player.t0 = player.next = player.ctx.currentTime + 0.06;
    player.step = 0;
    pulse('groove', g.bpm, perfAt(player.ctx, player.t0));
  }
}

function drum(ctx, out, noise, lane, at) {
  const g = ctx.createGain();

  g.connect(out);

  if (lane === 'kick') {
    const o = ctx.createOscillator();

    o.frequency.setValueAtTime(150, at);
    o.frequency.exponentialRampToValueAtTime(45, at + 0.12);
    g.gain.setValueAtTime(1, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.35);
    o.connect(g);
    o.start(at);
    o.stop(at + 0.36);

    return;
  }

  const n = ctx.createBufferSource(),
    f = ctx.createBiquadFilter();

  n.buffer = noise;
  // A snare is a band of noise around 2 kHz; a hi-hat is the hiss above 7 kHz, and short.
  f.type = lane === 'snare' ? 'bandpass' : 'highpass';
  f.frequency.value = lane === 'snare' ? 1800 : 7000;
  g.gain.setValueAtTime(lane === 'snare' ? 0.7 : 0.25, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + (lane === 'snare' ? 0.2 : 0.05));
  n.connect(f).connect(g);
  n.start(at);
  n.stop(at + 0.22);
}

function playGroove() {
  stopAll();
  const ctx = new AudioContext();
  const noise = ctx.createBuffer(1, Math.round(SR * 0.25), SR);
  const ch = noise.getChannelData(0);

  for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;

  const out = ctx.createGain();

  out.gain.value = 0.55;
  out.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.08;

  player = { ctx, kind: 'groove', noise, out, t0, next: t0, step: 0 };
  groove.auto = false;
  groove.last = -1;
  $('g-hear').setAttribute('aria-pressed', 'true');
  $('g-hear-label').textContent = 'Stop';
  pulse('groove', GROOVES[groove.i].bpm, perfAt(ctx, t0));
  runMachine();
}

function grooveIdle() {
  $('g-hear').setAttribute('aria-pressed', 'false');
  $('g-hear-label').textContent = 'Hear it';
  groove.t0 = performance.now();
  groove.last = -1;
  pulse('idle', heroBpm);
}

function light(s) {
  const prev = (s + STEPS - 1) % STEPS;

  groove.marks[prev].classList.remove('now');
  groove.marks[s].classList.add('now');

  for (const lane of LANES) {
    const pads = groove.pads[lane];

    pads[prev].classList.remove('now');
    pads[s].classList.add('now');

    if (!pads[s].classList.contains('on')) continue;

    const fade = { duration: 180 + 15000 / GROOVES[groove.i].bpm, easing: 'ease-out' };

    pads[s].animate([{ transform: 'scale(1.1)' }, { transform: 'scale(1)' }], fade);
    pads[s].firstChild.animate([{ opacity: 1 }, { opacity: 0 }], fade);
  }
}

function tickMachine() {
  groove.raf = 0;
  const g = GROOVES[groove.i];
  const stepSecs = 60 / g.bpm / 4;
  const live = player?.kind === 'groove' ? player : null;
  let at;

  if (live) {
    const { ctx } = live;

    // Hits are scheduled a little ahead on the audio clock; the lights follow what is heard.
    while (live.next < ctx.currentTime + 0.12) {
      for (const lane of LANES)
        if (g[lane].includes(live.step % STEPS)) drum(ctx, live.out, live.noise, lane, live.next);

      live.step++;
      live.next = live.t0 + live.step * stepSecs;
    }

    at = ctx.currentTime - latency(ctx) - live.t0;
  } else at = (performance.now() - groove.t0) / 1000;

  const step = Math.floor(at / stepSecs);

  if (step >= 0 && step !== groove.last && !reduceMotion) {
    groove.last = step;
    light(step % STEPS);

    if (groove.auto && !live && step >= STEPS * Math.ceil(AUTO_SECS / (stepSecs * STEPS)))
      setGroove((groove.i + 1) % GROOVES.length, false);
  }

  if (live || (groove.seen && motion)) groove.raf = requestAnimationFrame(tickMachine);
}

const runMachine = () => groove.raf || (groove.raf = requestAnimationFrame(tickMachine));

function wireMachine() {
  buildMachine();
  $('g-hear').addEventListener('click', () =>
    player?.kind === 'groove' ? stopAll() : playGroove(),
  );
  whileSeen($('groove'), (on) => {
    groove.seen = on;

    if (on) {
      groove.t0 = performance.now();
      groove.last = -1;
      runMachine();
    }
  });
}

// ---- motion ----------------------------------------------------------------------------

function intro() {
  const split = SplitText.create('#hero-title', { type: 'words,chars', mask: 'words' });
  const tl = G.timeline({ defaults: { ease: 'expo.out' } });

  tl.from(split.chars, { yPercent: 118, rotate: 8, duration: 1.1, stagger: 0.024 }, 0.15)
    .from('#live', { y: 16, autoAlpha: 0, duration: 0.8 }, 0)
    .from('.hero .lede', { y: 26, autoAlpha: 0, duration: 1 }, 0.55)
    .from('.hero .ctas > *', { y: 26, autoAlpha: 0, duration: 0.9, stagger: 0.08 }, 0.7)
    .from('.glow', { autoAlpha: 0, scale: 0.5, duration: 2.2, ease: 'power2.out' }, 0)
    .from('#turntable', { scale: 0.72, rotate: -30, autoAlpha: 0, duration: 1.5 }, 0.1)
    .from(
      '.float',
      {
        scale: 0,
        autoAlpha: 0,
        rotation: () => G.utils.random(-70, 70),
        duration: 1.3,
        stagger: 0.08,
        ease: 'back.out(1.6)',
      },
      0.35,
    )
    .from(
      '#arm-g',
      { rotation: -28, svgOrigin: ARM_PIVOT, duration: 1.3, ease: 'power3.out' },
      0.45,
    )
    .from('#sticker', { scale: 0, rotation: -140, duration: 1, ease: 'back.out(2)' }, 0.95)
    .from('#hear', { y: 16, autoAlpha: 0, duration: 0.8 }, 1.1);
  document.documentElement.classList.remove('intro');

  // Idle drift for the sleeves; the pointer adds parallax on top.
  const drift = $$('.float').map((f, i) =>
    G.to(f, {
      yPercent: i % 2 ? 7 : -7,
      rotation: i % 2 ? -3 : 3,
      duration: 2.6 + i * 0.45,
      ease: 'sine.inOut',
      yoyo: true,
      repeat: -1,
      delay: 1.6,
    }),
  );
  let heroSeen = true;

  whileSeen(document.querySelector('.hero'), (on) => {
    heroSeen = on;
    drift.forEach((t) => t.paused(!on));
  });

  if (matchMedia('(pointer: fine)').matches) {
    const floats = $$('.float').map((f) => ({
      d: +f.dataset.depth,
      x: G.quickTo(f, 'x', { duration: 0.9, ease: 'power3' }),
      y: G.quickTo(f, 'y', { duration: 0.9, ease: 'power3' }),
    }));
    const tx = G.quickTo('#turntable', 'x', { duration: 1.2, ease: 'power3' }),
      ty = G.quickTo('#turntable', 'y', { duration: 1.2, ease: 'power3' });

    addEventListener('pointermove', (e) => {
      if (!heroSeen) return;

      const nx = e.clientX / innerWidth - 0.5,
        ny = e.clientY / innerHeight - 0.5;

      floats.forEach((f) => (f.x(nx * 44 * f.d), f.y(ny * 36 * f.d)));
      tx(nx * -10);
      ty(ny * -8);
    });
  }

  G.to('.hero-stage', {
    yPercent: 10,
    ease: 'none',
    scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
  });
}

function crateScene(step, enter) {
  const tl = G.timeline();
  const q = G.utils.selector(step);

  if (enter) tl.from(q('.crate'), { y: 50, autoAlpha: 0, duration: 0.6, ease: 'power3.out' }, 0);

  q('.rack i')
    .slice(0, 6)
    .forEach((s, i) => {
      // Each record leans on the one flipped before it, as when digging through a crate.
      tl.to(s, { y: '-12%', duration: 0.16, ease: 'power2.out' }, 0.25 + i * 0.26).to(
        s,
        { y: '0%', rotationX: -80 + i * 5, duration: 0.3, ease: 'power2.in' },
        '>-0.02',
      );
    });
  tl.from(q('.counts'), { y: 14, autoAlpha: 0, duration: 0.35, ease: 'power2.out' }, 0.15);
  q('.count').forEach((c) =>
    tl.add(
      countTo(c, +c.dataset.to, (v) => Math.round(v).toLocaleString('en-US'), 1.7),
      0.2,
    ),
  );

  return tl;
}

function listenScene(step, enter) {
  const tl = G.timeline();
  const q = G.utils.selector(step);

  if (enter) tl.from(q('.wave'), { scaleY: 0, duration: 0.5, ease: 'power3.out' }, 0);

  tl.fromTo(q('.scan'), { left: '7%' }, { left: '93%', duration: 1.6, ease: 'none' }, 0.2).fromTo(
    q('.layer.lit'),
    { clipPath: 'inset(0% 100% 0% 0%)' },
    { clipPath: 'inset(0% 0% 0% 0%)', duration: 1.6, ease: 'none' },
    0.2,
  );

  for (const [tag, at] of [
    ['.t-bpm', 0.8],
    ['.t-key', 1.35],
  ])
    tl.from(
      q(tag),
      { y: 24, scale: 0.7, autoAlpha: 0, duration: 0.45, ease: 'back.out(2)' },
      at,
    ).from(
      q(`${tag} .bar i`),
      { scaleX: 0, transformOrigin: '0 50%', duration: 0.5, ease: 'power2.out' },
      at + 0.2,
    );

  return tl;
}

function setScene(step) {
  const tl = G.timeline();
  const q = G.utils.selector(step);

  tl.from(
    q('.ask'),
    {
      y: 20,
      scale: 0.85,
      autoAlpha: 0,
      transformOrigin: '100% 100%',
      duration: 0.45,
      ease: 'back.out(1.7)',
    },
    0,
  )
    .from(
      q('.row'),
      { x: 70, autoAlpha: 0, duration: 0.5, stagger: 0.14, ease: 'power3.out' },
      0.35,
    )
    .fromTo(
      q('.curve'),
      { clipPath: 'inset(0% 100% 0% 0%)' },
      { clipPath: 'inset(0% 0% 0% 0%)', duration: 1.1, ease: 'power1.inOut' },
      0.5,
    )
    .from(q('.saved'), { scale: 0, autoAlpha: 0, duration: 0.45, ease: 'back.out(2.6)' }, '>-0.15');

  return tl;
}

function waveBars() {
  const rand = lcg(5);
  const bars = Array.from({ length: 72 }, (_, i) => ({
    h: i % 6 === 0 ? 0.8 + rand() * 0.2 : 0.2 + rand() * 0.45,
    k: i % 6 === 0,
  }));

  for (const lit of [false, true]) {
    const layer = el('div', { className: `layer${lit ? ' lit' : ''}` });

    for (const b of bars) {
      const bar = el('i', { className: b.k ? 'k' : '' });

      bar.style.setProperty('--h', b.h.toFixed(2));
      layer.append(bar);
    }

    $('wave').append(layer);
  }
}

function story() {
  const box = $('story');
  const [s1, s2, s3] = $$('.step', box);
  const mm = G.matchMedia();

  mm.add('(min-width: 960px)', () => {
    box.classList.add('pin');
    G.set([s2, s3], { autoAlpha: 0 });
    const tl = G.timeline({
      scrollTrigger: { trigger: box, pin: true, start: 'top top', end: '+=320%', scrub: 0.8 },
    });
    const counter = $$('.story-count .now span', box);
    const swap = (from, to, n, at) => {
      tl.to(from, { autoAlpha: 0, y: -60, duration: 0.5, ease: 'power2.in' }, at)
        .fromTo(
          to,
          { autoAlpha: 0, y: 60 },
          { autoAlpha: 1, y: 0, duration: 0.5, ease: 'power2.out' },
          at + 0.35,
        )
        .to(counter, { yPercent: -100 * n, duration: 0.5, ease: 'power2.inOut' }, at);
    };

    tl.add(crateScene(s1, false), 0);
    swap(s1, s2, 1, 2.3);
    tl.add(listenScene(s2, false), 3.2);
    swap(s2, s3, 2, 5.4);
    tl.add(setScene(s3), 5.8);
    tl.to({}, { duration: 0.8 });

    return () => box.classList.remove('pin');
  });
  mm.add('(max-width: 959px)', () => {
    [
      [s1, crateScene],
      [s2, listenScene],
      [s3, setScene],
    ].forEach(([s, scene]) => {
      const tl = G.timeline({
        scrollTrigger: { trigger: s.querySelector('.step-visual'), start: 'top 78%' },
      });

      tl.from(
        s.querySelector('.step-copy'),
        { y: 30, autoAlpha: 0, duration: 0.7, ease: 'power3.out' },
        0,
      ).add(scene(s, true), 0.2);
    });
  });
}

// A headline's lines rise out of their own masks as its section arrives.
function lineReveal(title, trigger, start) {
  G.from(SplitText.create(title, { type: 'lines', mask: 'lines' }).lines, {
    yPercent: 110,
    stagger: 0.1,
    duration: 1,
    ease: 'expo.out',
    scrollTrigger: { trigger, start },
  });
}

function reveals() {
  lineReveal('#groove-title', '#groove', 'top 75%');
  G.from('.groove-now', {
    x: 60,
    autoAlpha: 0,
    duration: 1,
    ease: 'expo.out',
    scrollTrigger: { trigger: '#groove', start: 'top 70%' },
  });
  G.from('#grid i', {
    scale: 0,
    duration: 0.6,
    ease: 'back.out(2)',
    stagger: { grid: [3, 16], from: 'start', amount: 0.7 },
    scrollTrigger: { trigger: '.machine', start: 'top 80%' },
  });

  const tryTitle = SplitText.create('#try-title', { type: 'chars', mask: 'chars' });

  G.from(tryTitle.chars, {
    yPercent: 110,
    stagger: 0.03,
    duration: 0.9,
    ease: 'expo.out',
    scrollTrigger: { trigger: '.try', start: 'top 75%' },
  });
  G.from('.try-head p', {
    y: 24,
    autoAlpha: 0,
    duration: 0.9,
    ease: 'power3.out',
    scrollTrigger: { trigger: '.try', start: 'top 70%' },
  });
  G.from('#deck', {
    y: 80,
    autoAlpha: 0,
    duration: 1.1,
    ease: 'power3.out',
    scrollTrigger: { trigger: '#deck', start: 'top 88%' },
  });
  G.from('#deck-disc', {
    rotate: -90,
    scale: 0.8,
    duration: 1.4,
    ease: 'expo.out',
    scrollTrigger: { trigger: '#deck', start: 'top 80%' },
  });

  $$('.rule').forEach((rule) => {
    const words = SplitText.create(rule.querySelector('.big-line'), { type: 'words' }).words;

    G.fromTo(
      words,
      { opacity: 0.13 },
      {
        opacity: 1,
        stagger: 0.12,
        ease: 'none',
        scrollTrigger: { trigger: rule, start: 'top 82%', end: 'top 38%', scrub: true },
      },
    );
    G.from(rule.querySelector('p:last-child'), {
      y: 20,
      autoAlpha: 0,
      duration: 0.8,
      ease: 'power3.out',
      scrollTrigger: { trigger: rule, start: 'top 55%' },
    });
  });

  lineReveal('#get-title', '#get', 'top 70%');
  G.fromTo(
    '.get-disc',
    { xPercent: 40, rotate: -160 },
    {
      xPercent: 0,
      rotate: 0,
      ease: 'none',
      scrollTrigger: { trigger: '#get', start: 'top bottom', end: 'center center', scrub: 0.6 },
    },
  );

  const word = SplitText.create('.foot .wordmark', { type: 'chars', charsClass: 'char' });

  G.from(word.chars, {
    yPercent: 70,
    stagger: 0.04,
    ease: 'none',
    scrollTrigger: { trigger: '.foot', start: 'top bottom', end: 'bottom bottom', scrub: 0.5 },
  });
}

// ---- wiring ---------------------------------------------------------------------------------

function nav() {
  const bar = document.querySelector('.nav');
  const set = () => bar.classList.toggle('solid', scrollY > 24);

  addEventListener('scroll', set, { passive: true });
  set();
}

function beatRing() {
  const ring = $('beats');

  for (let i = 0; i < RING; i++) {
    const a = (i / RING) * TAU - Math.PI / 2;
    const dot = el('i');

    dot.style.left = `${50 + Math.cos(a) * 48}%`;
    dot.style.top = `${50 + Math.sin(a) * 48}%`;
    ring.append(dot);
  }
}

function wire() {
  $('hear').addEventListener('click', () => (player?.kind === 'hero' ? stopAll() : playHero()));
  $('play').addEventListener('click', () => (player?.kind === 'deck' ? stopAll() : playDeck()));
  $('loop').addEventListener('click', () => load(loopSamples, LOOP_TITLE, loopReading));
  $('file').addEventListener('change', (e) => {
    const [file] = e.target.files;

    // Cleared so picking the same file again still fires change.
    e.target.value = '';
    takeFile(file);
  });
  $('deck-platter').addEventListener('click', () => $('file').click());

  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

  addEventListener('dragenter', (e) => {
    if (hasFiles(e)) {
      depth++;
      document.body.classList.add('dragging');
    }
  });
  addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      document.body.classList.remove('dragging');
    }
  });
  addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;

    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    takeFile(e.dataTransfer.files[0]);
    $('try').scrollIntoView();
  });
}

function start() {
  waveBars();
  beatRing();
  wireMachine();
  nav();
  wire();

  record($('hero-vinyl'), {
    ...label('acid'),
    title: 'Selecta',
    ring: 'SIDE A · STEREO · 33⅓ RPM · MADE ON A MAC · ',
    sub: 'listening…',
    seed: 3,
  });
  record($('get-vinyl'), {
    ...label('coral'),
    title: 'Selecta',
    ring: 'PUT CLAUDE ON THE DECKS · FREE · OPEN SOURCE · ',
    sub: 'free · open source',
    seed: 21,
  });

  Promise.all(['800 40px Unbounded', '500 20px "DM Mono"'].map((f) => document.fonts.load(f))).then(
    redrawRecords,
    () => {},
  );

  if (motion) {
    G.registerPlugin(ScrollTrigger, SplitText);
    document.fonts.ready.then(() => {
      intro();
      story();
      reveals();
      ScrollTrigger.refresh();
    });
    heroSpin.speed(IDLE_RATE, 0.01);
    deckSpin.speed(IDLE_RATE, 0.01);
    new Spinner($('get-vinyl')).speed(0.5, 0.01);
    scratchable($('platter'), heroSpin);
  } else document.documentElement.classList.remove('intro');

  loopReading.then(heroReady, heroFail);
  load(loopSamples, LOOP_TITLE, loopReading);
}

start();
