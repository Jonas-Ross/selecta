import { expect, it, vi } from 'vitest';
import { observeSize } from '../ui/resize.js';

it('reports intrinsic card height with rounding room, including growth under a viewport cap', () => {
  let contentHeight = 801.25;
  const dataset: Record<string, string> = {};
  const shadowRoot = {};
  const element = {
    dataset,
    shadowRoot,
    getBoundingClientRect: () => ({
      height: 'measuring' in dataset ? contentHeight : Math.min(contentHeight, 720),
    }),
  };
  const frames: (() => void)[] = [];
  let notify = () => {};
  let mutate = () => {};
  const observe = vi.fn();
  const observeMutations = vi.fn();
  const disconnect = vi.fn();
  const onSize = vi.fn();
  const stop = observeSize(element, onSize, {
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    ResizeObserver: class {
      constructor(fn: () => void) {
        notify = fn;
      }
      observe = observe;
      disconnect = disconnect;
    },
    MutationObserver: class {
      constructor(fn: () => void) {
        mutate = fn;
      }
      observe = observeMutations;
      disconnect = disconnect;
    },
  });

  expect(observe).toHaveBeenCalledWith(element);
  expect(observeMutations).toHaveBeenCalledWith(
    shadowRoot,
    expect.objectContaining({ subtree: true, childList: true }),
  );
  frames.shift()!();
  expect(onSize).toHaveBeenLastCalledWith(804);
  expect(dataset).toEqual({});
  notify();
  notify();
  expect(frames).toHaveLength(1);
  frames.shift()!();
  expect(onSize).toHaveBeenCalledTimes(1);

  for (const height of [950.5, 620]) {
    contentHeight = height;
    notify();
    frames.shift()!();
    expect(onSize).toHaveBeenLastCalledWith(Math.ceil(height) + 2);
  }

  // Content grows inside the cap: the observed box stays at 720, so only the
  // DOM change can trigger the measurement.
  contentHeight = 900;
  mutate();
  frames.shift()!();
  expect(onSize).toHaveBeenLastCalledWith(902);

  stop();
  expect(disconnect).toHaveBeenCalledTimes(2);
});
