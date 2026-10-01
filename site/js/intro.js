// The hero's entrance, then pointer and scroll parallax on the film.
import { gsap, whileSeen } from './motion.js';

export function intro() {
  const split = SplitText.create('#hero-title', {
    type: 'words,chars',
    mask: 'words',
    wordsClass: 'w',
  });
  const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });

  tl.from('.film', { autoAlpha: 0, scale: 1.08, duration: 2.4, ease: 'power2.out' }, 0)
    .from(split.chars, { yPercent: 140, rotate: 8, duration: 1.1, stagger: 0.024 }, 0.15)
    .from('#live', { y: 16, autoAlpha: 0, duration: 0.8 }, 0)
    .from('.hero .lede', { y: 26, autoAlpha: 0, duration: 1 }, 0.55)
    .from('.hero .ctas > *', { y: 26, autoAlpha: 0, duration: 0.9, stagger: 0.08 }, 0.7)
    .from('#sticker', { scale: 0, rotation: -140, duration: 1, ease: 'back.out(2)' }, 0.95)
    .from('#hear', { y: 16, autoAlpha: 0, duration: 0.8 }, 1.1);
  document.documentElement.classList.remove('intro');

  if (matchMedia('(pointer: fine)').matches) {
    const fx = gsap.quickTo('#film', 'x', { duration: 1.4, ease: 'power3' }),
      fy = gsap.quickTo('#film', 'y', { duration: 1.4, ease: 'power3' });
    let seen = true;

    whileSeen(document.querySelector('.hero'), (on) => (seen = on));
    gsap.set('#film', { scale: 1.04 });
    addEventListener('pointermove', (e) => {
      if (!seen) return;

      fx((e.clientX / innerWidth - 0.5) * -18);
      fy((e.clientY / innerHeight - 0.5) * -12);
    });
  }

  gsap.to('.film', {
    yPercent: 14,
    ease: 'none',
    scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
  });
}
