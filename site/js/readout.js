// What the demo deck shows for a track: the numbers, how sure the engine is of each,
// and what Selecta would keep.
import { camelotName, parseCamelot, wheelStep } from './camelot.js';
import { $, el } from './dom.js';
import { countTo } from './motion.js';
import { label, record } from './record.js';
import { discSub, keyText } from './report.js';
import { LOOP } from './synth.js';

const DECK_RING = 'MEASURED IN THIS TAB · NOTHING UPLOADED · ';
const LABELS = ['acid', 'coral', 'uv', 'teal', 'pink'];

// The loop keeps the house colour; a dropped file gets one of the others, the same each time.
function deckLabel(title, loop) {
  if (loop) return label(LABELS[0]);

  let h = 0;

  for (const c of title) h = (h * 31 + c.charCodeAt(0)) >>> 0;

  return label(LABELS[1 + (h % (LABELS.length - 1))]);
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

function wheel(key) {
  const onWheel = key && !key.uncertain;

  $('wheel').hidden = !onWheel;

  if (!onWheel) return;

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

function verdict(track) {
  const { tempo, key } = track.report.features;
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

  if (track.loop)
    said.push(`This loop is built at ${LOOP.bpm} BPM in ${LOOP.key}, so you can check the answer.`);

  return said.join(' ');
}

// A guessed tempo gets no metronome, so the button doesn't promise one.
export const playLabel = (report) => {
  const tempo = report?.features.tempo;

  return tempo && !tempo.uncertain ? 'Play with metronome' : 'Play';
};

export function status(text, err = false) {
  $('status').textContent = text;
  $('status').classList.toggle('err', err);
}

export function blank(title, loop) {
  $('deck-title').textContent = title;
  // A reading still counting up from the last track would overwrite the placeholders.
  $('bpm')._tw?.kill();
  $('camelot')._tw?.kill();
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

// track is the deck's measured track: its report, measured window and whether it's the loop.
export function render(track, ms) {
  const { tempo, key } = track.report.features;

  countTo(
    $('bpm'),
    tempo?.bpm,
    tempo?.uncertain ? (v) => `~${Math.round(v)}` : (v) => v.toFixed(1),
  );
  rollCode($('camelot'), key?.camelot);
  $('keyname').textContent = keyText(key);
  reading('tempo', tempo);
  reading('key', key);
  wheel(key);
  $('said').textContent = verdict(track);
  status(
    `Measured ${track.head.long ? 'the middle 30 seconds' : 'it'} in ${Math.round(ms)} ms. Nothing left this tab.`,
  );
  $('build').textContent = `This is algorithm ${track.report.algorithm_version}.`;
  record($('deck-vinyl'), { sub: discSub(tempo, key) });
  $('play-label').textContent = playLabel(track.report);
  $('play').disabled = false;
}

export function fail(title, reason) {
  blank(title, false);
  $('said').textContent = reason;
  status('Nothing was measured.', true);
  record($('deck-vinyl'), { sub: 'nothing measured' });
}
