// Measure content, not the iframe viewport: host document styles and rounding
// must not feed back into the next requested height.
export function observeSize(element, onSize) {
  let scheduled = false;
  let previous;
  const report = () => {
    if (scheduled) return;

    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      // Leave two CSS pixels for iframe borders/fractional host rounding.
      const height = Math.ceil(element.getBoundingClientRect().height) + 2;

      if (height === previous) return;

      previous = height;
      onSize(height);
    });
  };
  const observer = new ResizeObserver(report);

  observer.observe(element);
  report();

  return () => observer.disconnect();
}
