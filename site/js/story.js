// How it works, in three steps: dig the crate, listen, build the set. Pinned and scrubbed
// on wide screens; each step plays once as it arrives on narrow ones.
import { $, $$, el } from './dom.js';
import { countTo, gsap } from './motion.js';
import { lcg } from './synth.js';

function crateScene(step, enter) {
  const tl = gsap.timeline();
  const q = gsap.utils.selector(step);
  // Last in the markup is the front of the crate.
  const sleeves = q('.rack i').reverse();

  if (enter) tl.from(q('.crate'), { y: 50, autoAlpha: 0, duration: 0.6, ease: 'power3.out' }, 0);

  // Digging: the front record comes up for a look, then goes in at the back of the crate.
  sleeves.slice(0, 4).forEach((s, i) => {
    const at = 0.25 + i * 0.42;

    tl.to(s, { yPercent: -55, rotation: i % 2 ? 2.5 : -2, duration: 0.2, ease: 'power2.out' }, at)
      .set(s, { zIndex: -1 }, at + 0.28)
      .to(s, { yPercent: 0, rotation: 0, duration: 0.18, ease: 'power2.in' }, at + 0.28);
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
  const tl = gsap.timeline();
  const q = gsap.utils.selector(step);

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
  const tl = gsap.timeline();
  const q = gsap.utils.selector(step);

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

// The listen step's waveform, built whether or not anything moves.
export function waveBars() {
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

export function story() {
  const box = $('story');
  const [s1, s2, s3] = $$('.step', box);
  const mm = gsap.matchMedia();

  mm.add('(min-width: 960px)', () => {
    box.classList.add('pin');
    gsap.set([s2, s3], { autoAlpha: 0 });
    const tl = gsap.timeline({
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
      const tl = gsap.timeline({
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
