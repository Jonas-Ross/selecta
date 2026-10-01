// Scroll reveals for everything below the story: headlines, the machine, the deck, the rules.
import { $$ } from './dom.js';
import { HIDDEN, gsap, maskedSplit } from './motion.js';

// A headline's lines rise out of their own masks as its section arrives.
function lineReveal(title, trigger, start) {
  gsap.from(maskedSplit(title, 'lines').lines, {
    yPercent: HIDDEN,
    stagger: 0.1,
    duration: 1,
    ease: 'expo.out',
    scrollTrigger: { trigger, start },
  });
}

export function reveals() {
  lineReveal('#groove-title', '#groove', 'top 75%');
  gsap.from('.groove-now', {
    x: 60,
    autoAlpha: 0,
    duration: 1,
    ease: 'expo.out',
    scrollTrigger: { trigger: '#groove', start: 'top 70%' },
  });
  gsap.from('#grid i', {
    scale: 0,
    duration: 0.6,
    ease: 'back.out(2)',
    stagger: { grid: [3, 16], from: 'start', amount: 0.7 },
    scrollTrigger: { trigger: '.machine', start: 'top 80%' },
  });

  const tryTitle = maskedSplit('#try-title', 'chars');

  gsap.from(tryTitle.chars, {
    yPercent: HIDDEN,
    stagger: 0.03,
    duration: 0.9,
    ease: 'expo.out',
    scrollTrigger: { trigger: '.try', start: 'top 75%' },
  });
  gsap.from('.try-head p', {
    y: 24,
    autoAlpha: 0,
    duration: 0.9,
    ease: 'power3.out',
    scrollTrigger: { trigger: '.try', start: 'top 70%' },
  });
  gsap.from('#deck', {
    y: 80,
    autoAlpha: 0,
    duration: 1.1,
    ease: 'power3.out',
    scrollTrigger: { trigger: '#deck', start: 'top 88%' },
  });
  gsap.from('#deck-disc', {
    rotate: -90,
    scale: 0.8,
    duration: 1.4,
    ease: 'expo.out',
    scrollTrigger: { trigger: '#deck', start: 'top 80%' },
  });

  $$('.rule').forEach((rule) => {
    const words = SplitText.create(rule.querySelector('.big-line'), { type: 'words' }).words;

    gsap.fromTo(
      words,
      { opacity: 0.13 },
      {
        opacity: 1,
        stagger: 0.12,
        ease: 'none',
        scrollTrigger: { trigger: rule, start: 'top 82%', end: 'top 38%', scrub: true },
      },
    );
    gsap.from(rule.querySelector('p:last-child'), {
      y: 20,
      autoAlpha: 0,
      duration: 0.8,
      ease: 'power3.out',
      scrollTrigger: { trigger: rule, start: 'top 55%' },
    });
  });

  lineReveal('#get-title', '#get', 'top 70%');
  gsap.fromTo(
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

  gsap.from(word.chars, {
    yPercent: 70,
    stagger: 0.04,
    ease: 'none',
    scrollTrigger: { trigger: '.foot', start: 'top bottom', end: 'bottom bottom', scrub: 0.5 },
  });
}
