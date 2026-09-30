// The hero's entrance, then its idle drift, pointer parallax and scroll parallax.
import { $$ } from './dom.js';
import { ARM_PIVOT } from './hero.js';
import { gsap, whileSeen } from './motion.js';

export function intro() {
  const split = SplitText.create('#hero-title', { type: 'words,chars', mask: 'words' });
  const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });

  tl.from(split.chars, { yPercent: 118, rotate: 8, duration: 1.1, stagger: 0.024 }, 0.15)
    .from('#live', { y: 16, autoAlpha: 0, duration: 0.8 }, 0)
    .from('.hero .lede', { y: 26, autoAlpha: 0, duration: 1 }, 0.55)
    .from('.hero .ctas > *', { y: 26, autoAlpha: 0, duration: 0.9, stagger: 0.08 }, 0.7)
    .from('.glow', { autoAlpha: 0, scale: 0.5, duration: 2.2, ease: 'power2.out' }, 0)
    .from('#turntable', { scale: 0.72, rotate: -30, autoAlpha: 0, duration: 1.5 }, 0.1)
    .from(
      '.float',
      {
        scale: 0,
        autoAlpha: 0,
        rotation: () => gsap.utils.random(-70, 70),
        duration: 1.3,
        stagger: 0.08,
        ease: 'back.out(1.6)',
      },
      0.35,
    )
    .from(
      '#arm-g',
      { rotation: -28, svgOrigin: ARM_PIVOT, duration: 1.3, ease: 'power3.out' },
      0.45,
    )
    .from('#sticker', { scale: 0, rotation: -140, duration: 1, ease: 'back.out(2)' }, 0.95)
    .from('#hear', { y: 16, autoAlpha: 0, duration: 0.8 }, 1.1);
  document.documentElement.classList.remove('intro');

  // Idle drift for the sleeves; the pointer adds parallax on top.
  const drift = $$('.float').map((f, i) =>
    gsap.to(f, {
      yPercent: i % 2 ? 7 : -7,
      rotation: i % 2 ? -3 : 3,
      duration: 2.6 + i * 0.45,
      ease: 'sine.inOut',
      yoyo: true,
      repeat: -1,
      delay: 1.6,
    }),
  );
  let heroSeen = true;

  whileSeen(document.querySelector('.hero'), (on) => {
    heroSeen = on;
    drift.forEach((t) => t.paused(!on));
  });

  if (matchMedia('(pointer: fine)').matches) {
    const floats = $$('.float').map((f) => ({
      d: +f.dataset.depth,
      x: gsap.quickTo(f, 'x', { duration: 0.9, ease: 'power3' }),
      y: gsap.quickTo(f, 'y', { duration: 0.9, ease: 'power3' }),
    }));
    const tx = gsap.quickTo('#turntable', 'x', { duration: 1.2, ease: 'power3' }),
      ty = gsap.quickTo('#turntable', 'y', { duration: 1.2, ease: 'power3' });

    addEventListener('pointermove', (e) => {
      if (!heroSeen) return;

      const nx = e.clientX / innerWidth - 0.5,
        ny = e.clientY / innerHeight - 0.5;

      floats.forEach((f) => (f.x(nx * 44 * f.d), f.y(ny * 36 * f.d)));
      tx(nx * -10);
      ty(ny * -8);
    });
  }

  gsap.to('.hero-stage', {
    yPercent: 10,
    ease: 'none',
    scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
  });
}
