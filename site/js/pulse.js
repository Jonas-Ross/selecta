// Things that move on the beat use the Web Animations clock, so a pulse can be pinned
// to the moment the audio plays a kick rather than to whenever a frame happens to land.
import { $$, css } from './dom.js';
import { reduceMotion } from './motion.js';

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
    // The film brightens on every kick, as if the room's lights were on the beat.
    ['#film', hit({ filter: 'brightness(1.4)' }, { filter: 'brightness(1)' }), 0],
    [
      '#hero-title .dot',
      hit(
        { transform: 'scale(1.45)', color: css('--acid') },
        { transform: 'scale(1)', color: css('--coral') },
      ),
      0,
    ],
    meter('#hear .eq i'),
  ],
  groove: [meter('#g-hear .eq i')],
};
let pulses = [];
// The live dot keeps the built-in loop's tempo once the engine is sure of it.
let idleBpm = 0;

export function pulse(mode, bpm, zero = document.timeline.currentTime) {
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

export const setIdleBpm = (bpm) => (idleBpm = bpm);
export const idlePulse = () => pulse('idle', idleBpm);
