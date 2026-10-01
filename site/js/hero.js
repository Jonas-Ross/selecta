// The hero: a film of a needle in the groove, the built-in loop to play over it, and the
// engine's reading of that loop on the sticker.
import { current, perfAt, play, playBuffer, toBuffer, toggle } from './audio.js';
import { $ } from './dom.js';
import { SR } from './engine.js';
import { settleMark } from './mark.js';
import { countTo, motion, whileSeen } from './motion.js';
import { idlePulse, pulse, setIdleBpm } from './pulse.js';
import { keyText } from './report.js';
import { LOOP } from './synth.js';

let loop = null;
let buffer = null;

function idle() {
  $('hear').setAttribute('aria-pressed', 'false');
  $('hear-label').textContent = 'Hear the beat';
  idlePulse();
}

function playLoop() {
  const { ctx } = play('hero', idle);
  // Loop whole bars only, so the beat never stumbles at the seam.
  const bar = (4 * 60) / LOOP.bpm;

  buffer ??= toBuffer(loop.samples.subarray(0, Math.round(Math.floor(LOOP.secs / bar) * bar * SR)));
  const t0 = ctx.currentTime + 0.05;

  playBuffer(ctx, buffer, t0, true);
  $('hear').setAttribute('aria-pressed', 'true');
  $('hear-label').textContent = 'Stop';
  pulse('live', LOOP.bpm, perfAt(ctx, t0));
}

function ready({ report }) {
  const { tempo, key } = report.features;
  const sure = tempo && !tempo.uncertain;

  setIdleBpm(sure ? tempo.bpm : 0);

  if (sure) settleMark();

  $('live').classList.add('ready');
  $('live-text').textContent = 'Engine live in this tab';
  countTo($('st-bpm'), tempo?.bpm, (v) => Math.round(v), 1.4);
  $('st-key').textContent = keyText(key);

  if (!current()) idlePulse();
}

function fail() {
  $('live').classList.add('fail');
  $('live-text').textContent = "The engine didn't load in this browser";
  $('st-bpm').textContent = '--';
  $('st-key').textContent = 'no engine';
}

function film() {
  const video = $('film');

  // Reduced motion keeps the poster and never fetches the film; otherwise playing it
  // the first time it is seen is what loads it.
  if (!motion) return;

  whileSeen(video, (on) => (on ? video.play().catch(() => {}) : video.pause()));
}

export function initHero(builtIn) {
  loop = builtIn;
  film();
  $('hear').addEventListener('click', () => toggle('hero', playLoop));
  loop.reading.then(ready, fail);
}
