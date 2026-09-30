// Measure content, not the iframe viewport: host document styles and rounding
// must not feed back into the next requested height. The observers and frame
// scheduler are injectable so tests can drive them without a browser.
export function observeSize(element, onSize, hooks = {}) {
  const {
    ResizeObserver = globalThis.ResizeObserver,
    MutationObserver = globalThis.MutationObserver,
    requestAnimationFrame = globalThis.requestAnimationFrame,
  } = hooks;
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
  // A viewport cap pins the observed box while content inside it grows, so
  // the DOM changes that cause growth must trigger a measurement as well.
  // The attribute list excludes the measuring flag to keep this loop-free.
  const mutations = new MutationObserver(report);

  observer.observe(element);
  mutations.observe(element.shadowRoot ?? element, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['hidden', 'class', 'open', 'style'],
  });
  report();

  return () => {
    observer.disconnect();
    mutations.disconnect();
  };
}
