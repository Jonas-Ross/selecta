import { gsap, motion, whileSeen } from './motion.js';

// 33⅓ rpm, the speed a record really turns at.
const TURN_SECS = 1.8;

// Parked records drift instead of stopping, so the page never looks frozen.
export const IDLE_RATE = 0.22;
// Faster than 33⅓ while the engine listens, so waiting looks like work.
export const LISTEN_RATE = 1.8;

// Turns a record at 33⅓ with a speed knob, so it can drift, spin up and wind down.
export class Spinner {
  constructor(node) {
    this.node = node;
    this.rate = 0;
    this.tw = null;
    this.seen = true;
    whileSeen(node, (on) => {
      this.seen = on;
      this.tw?.paused(!on);
    });
  }
  make() {
    if (!motion) return;

    const r = gsap.getProperty(this.node, 'rotation');

    this.tw?.kill();
    this.tw = gsap.fromTo(
      this.node,
      { rotation: r },
      { rotation: r + 360, duration: TURN_SECS, ease: 'none', repeat: -1 },
    );
    this.tw.timeScale(Math.max(this.rate, 0.001)).paused(!this.seen);
  }
  speed(rate, secs = 0.8) {
    this.rate = rate;

    if (!motion) return;

    if (!this.tw) this.make();

    gsap.to(this.tw, {
      timeScale: Math.max(rate, 0.001),
      duration: secs,
      ease: 'power2.inOut',
      overwrite: true,
    });
  }
}
