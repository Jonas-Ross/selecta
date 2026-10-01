// The drum machine: one bar per genre, stepping through on its own until someone plays it.
import { current, latency, perfAt, play, toggle } from './audio.js';
import { $, el } from './dom.js';
import { SR } from './engine.js';
import { countTo, gsap, motion, reduceMotion, whileSeen } from './motion.js';
import { idlePulse, pulse } from './pulse.js';

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

// The player while the machine is the thing playing, else null.
const live = () => (current()?.kind === 'groove' ? current() : null);

function build() {
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
    gsap.fromTo(
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
    gsap.fromTo(
      '#g-name',
      { yPercent: 70, autoAlpha: 0 },
      { yPercent: 0, autoAlpha: 1, duration: 0.45, ease: 'back.out(2)' },
    );

  paintPattern(true);
  groove.last = -1;
  groove.t0 = performance.now();

  const p = live();

  if (p) {
    p.t0 = p.next = p.ctx.currentTime + 0.06;
    p.step = 0;
    pulse('groove', g.bpm, perfAt(p.ctx, p.t0));
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
  const p = play('groove', idle);
  const { ctx } = p;
  const noise = ctx.createBuffer(1, Math.round(SR * 0.25), SR);
  const ch = noise.getChannelData(0);

  for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;

  const out = ctx.createGain();

  out.gain.value = 0.55;
  out.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.08;

  Object.assign(p, { noise, out, t0, next: t0, step: 0 });
  groove.auto = false;
  groove.last = -1;
  $('g-hear').setAttribute('aria-pressed', 'true');
  $('g-hear-label').textContent = 'Stop';
  pulse('groove', GROOVES[groove.i].bpm, perfAt(ctx, t0));
  run();
}

function idle() {
  $('g-hear').setAttribute('aria-pressed', 'false');
  $('g-hear-label').textContent = 'Hear it';
  groove.t0 = performance.now();
  groove.last = -1;
  idlePulse();
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

function tick() {
  groove.raf = 0;
  const g = GROOVES[groove.i];
  const stepSecs = 60 / g.bpm / 4;
  const p = live();
  let at;

  if (p) {
    const { ctx } = p;

    // A hidden tab stops frames but not the audio clock; skip the steps it missed, don't burst them.
    p.step = Math.max(p.step, Math.ceil((ctx.currentTime - p.t0) / stepSecs));
    p.next = p.t0 + p.step * stepSecs;

    // Hits are scheduled a little ahead on the audio clock; the lights follow what is heard.
    while (p.next < ctx.currentTime + 0.12) {
      for (const lane of LANES)
        if (g[lane].includes(p.step % STEPS)) drum(ctx, p.out, p.noise, lane, p.next);

      p.step++;
      p.next = p.t0 + p.step * stepSecs;
    }

    at = ctx.currentTime - latency(ctx) - p.t0;
  } else at = (performance.now() - groove.t0) / 1000;

  const step = Math.floor(at / stepSecs);

  if (step >= 0 && step !== groove.last && !reduceMotion) {
    groove.last = step;
    light(step % STEPS);

    if (groove.auto && !p && step >= STEPS * Math.ceil(AUTO_SECS / (stepSecs * STEPS)))
      setGroove((groove.i + 1) % GROOVES.length, false);
  }

  if (p || (groove.seen && motion)) groove.raf = requestAnimationFrame(tick);
}

const run = () => groove.raf || (groove.raf = requestAnimationFrame(tick));

export function initMachine() {
  build();
  $('g-hear').addEventListener('click', () => toggle('groove', playGroove));
  whileSeen($('groove'), (on) => {
    groove.seen = on;

    if (on) {
      groove.t0 = performance.now();
      groove.last = -1;
      run();
    }
  });
}
