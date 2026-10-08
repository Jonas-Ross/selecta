// Entry point: sends the built-in loop to the engine, starts each section, then the motion.
import { initDeck } from './deck.js';
import { initDesk } from './desk.js';
import { $ } from './dom.js';
import { SR, analyze, engine, headline } from './engine.js';
import { initHero } from './hero.js';
import { intro } from './intro.js';
import { initMachine } from './machine.js';
import { gsap, motion } from './motion.js';
import { label, record, redrawRecords, titleFont } from './record.js';
import { reveals } from './reveals.js';
import { Spinner } from './spinner.js';
import { story, waveBars } from './story.js';
import { synthLoop } from './synth.js';

function nav() {
  const bar = document.querySelector('.nav');
  const set = () => bar.classList.toggle('solid', scrollY > 24);

  addEventListener('scroll', set, { passive: true });
  set();
}

engine(); // Fetch and compile the engine while the loop is synthesized.
const samples = synthLoop(SR);
const head = headline(samples.length);
// Measured once here and shared: the hero shows this reading and the deck opens on it.
const loop = { samples, reading: analyze(samples.subarray(head.start, head.end)) };

waveBars();
initMachine();
nav();
initHero(loop);
initDeck(loop);
initDesk();
record($('get-vinyl'), {
  ...label('coral'),
  title: 'Selecta',
  ring: 'PUT YOUR AI ON THE DECKS · FREE · OPEN SOURCE · ',
  sub: 'free · open source',
  seed: 21,
});

Promise.all([titleFont(40), '500 20px "DM Mono"'].map((f) => document.fonts.load(f))).then(
  redrawRecords,
  () => {},
);

if (motion) {
  gsap.registerPlugin(ScrollTrigger, SplitText);
  void document.fonts.ready.then(() => {
    intro();
    story();
    reveals();
    ScrollTrigger.refresh();
  });
  new Spinner($('get-vinyl')).speed(0.5, 0.01);
} else document.documentElement.classList.remove('intro');
