// The logo is a groove wound one beat per turn, so its kicks line up only at the right
// tempo. The markup draws them scattered; they line up once the engine is sure of one.
import { $$ } from './dom.js';
import { gsap, motion } from './motion.js';

export function settleMark() {
  const kicks = $$('#mark .kick');

  if (!motion) return kicks.forEach((k) => k.setAttribute('transform', 'rotate(0 16 16)'));

  gsap.to(kicks, {
    rotation: 0,
    svgOrigin: '16 16',
    duration: 1.1,
    ease: 'elastic.out(1, 0.55)',
    stagger: 0.09,
  });
}
