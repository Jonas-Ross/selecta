// Whether the page moves at all, and the motion helpers every section shares.
export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const gsap = window.gsap;
export const motion = !!gsap && !reduceMotion;

// Splits text into masked pieces. base.css pads every mask so tails and overhangs show,
// so a piece has to travel further than its own height to hide.
export const HIDDEN = 135;
export const maskedSplit = (target, mask, type = mask) =>
  SplitText.create(target, { type, mask, [`${mask}Class`]: mask });

// Endless motion pauses while its element is off screen, so the page goes idle as it's read.
const watchers = new Map();
const onScreen = new IntersectionObserver((entries) =>
  entries.forEach((e) => watchers.get(e.target)(e.isIntersecting)),
);

export function whileSeen(node, fn) {
  watchers.set(node, fn);
  onScreen.observe(node);
}

export function countTo(node, to, fmt, secs = 1, from = 0) {
  node._tw?.kill();

  if (to == null) return (node.textContent = '--');

  if (!motion) return (node.textContent = fmt(to));

  const o = { v: from };

  return (node._tw = gsap.to(o, {
    v: to,
    duration: secs,
    ease: 'power3.out',
    onUpdate: () => (node.textContent = fmt(o.v)),
  }));
}
