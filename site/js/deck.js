// The try-it deck: measures the built-in loop or a dropped file in this tab, then plays
// the measured stretch with a metronome locked to its kicks.
import { current, latency, play, playBuffer, stop, toBuffer, toggle } from './audio.js';
import { $, $$, el } from './dom.js';
import { SR, analyze, decodeFile, headline } from './engine.js';
import { motion } from './motion.js';
import { blank, fail, playLabel, render, status } from './readout.js';
import { IDLE_RATE, LISTEN_RATE, Spinner } from './spinner.js';

// Lights around the demo record: four bars of four beats.
const RING = 16;
const LOOP_TITLE = 'Built-in loop';

const track = { loop: false, head: null, report: null, origin: 0, buffer: null, run: 0 };
let builtIn = null;
let spin = null;

async function load(samples, title, pending) {
  stop();
  const run = ++track.run;
  const loop = samples === builtIn.samples;
  const head = headline(samples.length);

  Object.assign(track, { loop, head, report: null, origin: 0, buffer: null });
  blank(title, loop);
  spin.speed(LISTEN_RATE, 0.4);
  status(head.long ? 'Listening to the middle 30 seconds…' : 'Listening…');

  try {
    const { report, ms } = await (pending ?? analyze(samples.subarray(head.start, head.end)));

    if (run !== track.run) return;

    const tempo = report.features.tempo;

    track.report = report;
    // Playback is the measured window alone: the metronome only knows that stretch's tempo.
    track.buffer = toBuffer(samples.subarray(head.start, head.end));

    if (tempo) track.origin = head.start / SR + tempo.beat_offset_secs;

    spin.speed(IDLE_RATE, 1);
    render(track, ms);
  } catch (err) {
    if (run !== track.run) return;

    spin.speed(IDLE_RATE, 1);
    fail(title, `The engine could not measure this: ${err.message}`);
  }
}

const loadLoop = () => load(builtIn.samples, LOOP_TITLE, builtIn.reading);

async function takeFile(file) {
  if (!file) return;

  stop();
  const run = ++track.run;
  const name = file.name.replace(/\.[^.]+$/, '');

  // Decoding can take seconds; the old track's readings and Play must not linger meanwhile.
  blank(name, false);
  status(`Decoding ${file.name}…`);
  spin.speed(LISTEN_RATE, 0.4);

  try {
    const samples = await decodeFile(file);

    // Another file or the loop was picked while this one decoded.
    if (run !== track.run) return;

    if (samples.length < SR * 5) throw new Error('it is shorter than five seconds');

    await load(samples, name);
  } catch (err) {
    if (run !== track.run) return;

    spin.speed(IDLE_RATE, 1);
    const why = /shorter than/.test(err.message) ? err.message : 'your browser cannot decode it';

    fail(name, `Could not read this file: ${why}. Try an MP3, AAC or WAV.`);
  }
}

function idle() {
  $('play').classList.remove('on');
  $('play-label').textContent = playLabel(track.report);
  $$('#beats i').forEach((d) => d.classList.remove('on'));
  spin.speed(IDLE_RATE, 1);
}

function playTrack() {
  stop();

  if (!track.report) return;

  const tempo = track.report.features.tempo;
  const p = play('deck', idle);
  const { ctx } = p;
  const t0 = ctx.currentTime + 0.15;

  playBuffer(ctx, track.buffer, t0).onended = () => current() === p && stop();

  // A guessed tempo gets no metronome: clicking along to a guess would claim a beat that isn't there.
  const period = tempo && !tempo.uncertain ? 60 / tempo.bpm : 0;
  const fromSec = track.head.start / SR;
  const origin = track.origin;
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

  const tick = () => {
    const now = ctx.currentTime;
    const due = fromSec + now - t0;

    // A hidden tab stops frames but not the audio clock; skip the clicks it missed, don't burst them.
    if (next < due) next += Math.ceil((due - next) / period) * period;

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

    if (current() === p) p.raf = requestAnimationFrame(tick);
  };

  p.raf = requestAnimationFrame(tick);
  $('play').classList.add('on');
  $('play-label').textContent = 'Stop';
  spin.speed(1, 0.5);
}

function beatRing() {
  const ring = $('beats');

  for (let i = 0; i < RING; i++) {
    const a = (i / RING) * Math.PI * 2 - Math.PI / 2;
    const dot = el('i');

    dot.style.left = `${50 + Math.cos(a) * 48}%`;
    dot.style.top = `${50 + Math.sin(a) * 48}%`;
    ring.append(dot);
  }
}

// A file dropped anywhere on the page lands on the deck.
function acceptDrops() {
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
    void takeFile(e.dataTransfer.files[0]);
    $('try').scrollIntoView();
  });
}

export function initDeck(loop) {
  builtIn = loop;
  spin = new Spinner(document.querySelector('#deck-disc .spin'));
  beatRing();
  $('play').addEventListener('click', () => toggle('deck', playTrack));
  $('loop').addEventListener('click', () => void loadLoop());
  $('file').addEventListener('change', (e) => {
    const [file] = e.target.files;

    // Cleared so picking the same file again still fires change.
    e.target.value = '';
    void takeFile(file);
  });
  $('deck-platter').addEventListener('click', () => $('file').click());
  acceptDrops();

  if (motion) spin.speed(IDLE_RATE, 0.01);

  void loadLoop();
}
