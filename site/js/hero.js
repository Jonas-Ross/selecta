// The turntable up top: plays the built-in loop and wears the engine's reading on its label.
import { current, perfAt, play, playBuffer, toBuffer, toggle } from './audio.js';
import { $ } from './dom.js';
import { SR } from './engine.js';
import { countTo, gsap, motion } from './motion.js';
import { idlePulse, pulse, setIdleBpm } from './pulse.js';
import { label, record } from './record.js';
import { discSub, keyText } from './report.js';
import { IDLE_RATE, Spinner, scratchable } from './spinner.js';
import { LOOP } from './synth.js';

// Tonearm swing that sets the stylus in the outer grooves, about its pivot.
const ARM_PLAY = 18;

export const ARM_PIVOT = '108 6';

let loop = null;
let buffer = null;
let spin = null;

function arm(deg, secs) {
  const g = $('arm-g');

  if (motion)
    gsap.to(g, {
      rotation: deg,
      svgOrigin: ARM_PIVOT,
      duration: secs,
      ease: 'power2.inOut',
      overwrite: true,
    });
  else g.setAttribute('transform', `rotate(${deg} ${ARM_PIVOT})`);
}

function idle() {
  $('hear').setAttribute('aria-pressed', 'false');
  $('hear-label').textContent = 'Hear the beat';
  spin.speed(IDLE_RATE, 1.2);
  arm(0, 0.7);
  idlePulse();
}

function playLoop() {
  const { ctx } = play('hero', idle);
  // Loop whole bars only, so the beat never stumbles at the seam.
  const bar = (4 * 60) / LOOP.bpm;

  buffer ??= toBuffer(loop.samples.subarray(0, Math.round(Math.floor(LOOP.secs / bar) * bar * SR)));
  // The needle drops first, then the music starts.
  const t0 = ctx.currentTime + (motion ? 0.5 : 0.05);

  playBuffer(ctx, buffer, t0, true);
  $('hear').setAttribute('aria-pressed', 'true');
  $('hear-label').textContent = 'Stop';
  arm(ARM_PLAY, 0.45);
  spin.speed(1, 0.5);
  pulse('live', LOOP.bpm, perfAt(ctx, t0));
}

function ready({ report }) {
  const { tempo, key } = report.features;

  setIdleBpm(tempo && !tempo.uncertain ? tempo.bpm : 0);
  $('live').classList.add('ready');
  $('live-text').textContent = 'Engine live in this tab';
  countTo($('st-bpm'), tempo?.bpm, (v) => Math.round(v), 1.4);
  $('st-key').textContent = keyText(key);

  if (!current()) idlePulse();

  record($('hero-vinyl'), { sub: discSub(tempo, key) });
}

function fail() {
  $('live').classList.add('fail');
  $('live-text').textContent = "The engine didn't load in this browser";
  $('st-bpm').textContent = '--';
  $('st-key').textContent = 'no engine';
}

export function initHero(builtIn) {
  loop = builtIn;
  spin = new Spinner(document.querySelector('#platter .spin'));
  record($('hero-vinyl'), {
    ...label('acid'),
    title: 'Selecta',
    ring: 'SIDE A · STEREO · 33⅓ RPM · MADE ON A MAC · ',
    sub: 'listening…',
    seed: 3,
  });
  $('hear').addEventListener('click', () => toggle('hero', playLoop));

  if (motion) {
    spin.speed(IDLE_RATE, 0.01);
    scratchable($('platter'), spin);
  }

  loop.reading.then(ready, fail);
}
