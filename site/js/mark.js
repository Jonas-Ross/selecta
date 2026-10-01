// The logo is a groove wound one beat per turn, so its kicks line up only at the right
// tempo. It waits with them scattered and lines them up once the engine is sure of one.
import { $$ } from './dom.js';
import { gsap, motion } from './motion.js';

// Degrees each kick sits off the line while nothing has been measured.
const DRIFT = [34, -48, 66];
const kicks = () => $$('#mark .kick');
const turn = (k, deg) => k.setAttribute('transform', `rotate(${deg} 16 16)`);

export function driftMark() {
  kicks().forEach((k, i) => turn(k, DRIFT[i]));
}

export function settleMark(sure) {
  if (!sure) return driftMark();

  if (!motion) return kicks().forEach((k) => turn(k, 0));

  gsap.to(kicks(), {
    rotation: 0,
    svgOrigin: '16 16',
    duration: 1.1,
    ease: 'elastic.out(1, 0.55)',
    stagger: 0.09,
  });
}
