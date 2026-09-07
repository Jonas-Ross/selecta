// Preview motion only: animate occurrence identities, never infer music facts.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const queue = document.getElementById('tracks');
let previous = new Map();
let scheduled = false;
let entered = false;

new MutationObserver(() => {
  if (scheduled) return;

  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const rows = [...queue.children];
    const next = new Map();

    for (const [index, row] of rows.entries()) {
      const id = row.querySelector('input')?.dataset.focus;
      const top = row.offsetTop;

      next.set(id, top);

      if (document.documentElement.dataset.variant !== 'pulse' || reducedMotion.matches) continue;

      if (!entered)
        row.animate(
          [
            { opacity: 0, transform: 'translateY(18px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          {
            duration: 450,
            delay: index * 55,
            easing: 'cubic-bezier(.16,1,.3,1)',
            fill: 'backwards',
          },
        );
      else if (previous.has(id) && previous.get(id) !== top)
        row.animate(
          [
            { transform: `translateY(${previous.get(id) - top}px)` },
            { transform: 'translateY(0)' },
          ],
          { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' },
        );
    }

    if (rows.length) entered = true;

    previous = next;
  });
}).observe(queue, { childList: true });

// The fixture host can compare palettes without remounting or losing typed text.
addEventListener('message', ({ source, origin, data }) => {
  if (source !== parent || origin !== location.origin || data?.type !== 'selecta-preview-palette')
    return;

  if (['copper', 'cobalt', 'ember', 'moss', 'oxblood'].includes(data.palette)) {
    document.documentElement.dataset.palette = data.palette;
  }
});
