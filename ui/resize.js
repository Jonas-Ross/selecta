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
      // Ask for the natural height even when the host caps the actual iframe.
      // Restore the constrained layout synchronously, before the next paint.
      element.dataset.measuring = '';
      const height = Math.ceil(element.getBoundingClientRect().height) + 2;

      delete element.dataset.measuring;

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
