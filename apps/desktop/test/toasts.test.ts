import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createToasts } from '../src/renderer/toasts.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const open = (store: ReturnType<typeof createToasts>) =>
  store
    .list()
    .filter((toast) => !toast.closing)
    .map((toast) => toast.text);

it('times out success after a few seconds and keeps errors until dismissed', () => {
  const store = createToasts();
  const closed = vi.fn();

  store.show({ tone: 'success', text: 'Saved', onClose: closed });
  store.show({ tone: 'error', text: 'Failed' });
  vi.advanceTimersByTime(4999);
  expect(open(store)).toEqual(['Saved', 'Failed']);
  vi.advanceTimersByTime(1);
  expect(open(store)).toEqual(['Failed']);
  expect(closed).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(60_000);
  expect(store.list().map((toast) => toast.text)).toEqual(['Failed']);
});

it('gives a toast with an action longer to reach it', () => {
  const store = createToasts();

  store.show({ tone: 'success', text: 'Swapped', action: { label: 'Undo', run: () => {} } });
  vi.advanceTimersByTime(7999);
  expect(open(store)).toEqual(['Swapped']);
  vi.advanceTimersByTime(1);
  expect(open(store)).toEqual([]);
});

it('stops every clock while any pause holds, and runs out only the time left after', () => {
  const store = createToasts();

  store.show({ text: 'Info' });
  vi.advanceTimersByTime(3000);
  store.pause('reading');
  store.pause('away');
  vi.advanceTimersByTime(60_000);
  store.resume('reading');
  vi.advanceTimersByTime(60_000);
  expect(open(store)).toEqual(['Info']);
  store.resume('away');
  vi.advanceTimersByTime(1999);
  expect(open(store)).toEqual(['Info']);
  vi.advanceTimersByTime(1);
  expect(open(store)).toEqual([]);
});

it('replaces a toast under the same key in place, counting repeats and restarting its clock', () => {
  const store = createToasts();

  store.show({ key: 'save', tone: 'error', text: 'Busy' });
  store.show({ text: 'Other' });
  store.show({ key: 'save', tone: 'error', text: 'Busy' });
  expect(store.list().map((toast) => [toast.text, toast.count])).toEqual([
    ['Busy', 2],
    ['Other', 1],
  ]);
  store.show({ key: 'save', tone: 'success', text: 'Saved' });
  expect(store.list()[0]).toMatchObject({ text: 'Saved', count: 1, ttl: 5000 });
  vi.advanceTimersByTime(4000);
  store.show({ key: 'save', tone: 'success', text: 'Saved' });
  vi.advanceTimersByTime(4000);
  expect(open(store)).toContain('Saved');
});

it('drops the oldest timed toast when a burst would fill the screen, never a sticky error', () => {
  const store = createToasts();

  store.show({ tone: 'error', text: 'Sticky' });

  for (const text of ['a', 'b', 'c', 'd']) store.show({ text });

  expect(open(store)).toEqual(['Sticky', 'b', 'c', 'd']);
});

it('merges the same words into one toast, and lets a screen clear everything it raised', () => {
  const store = createToasts();

  store.show({ tone: 'error', text: 'Offline' });
  store.show({ tone: 'error', text: 'Offline' });
  store.show({ key: 'k', text: 'Keyed' });
  expect(store.list().map((toast) => [toast.text, toast.count])).toEqual([
    ['Offline', 2],
    ['Keyed', 1],
  ]);
  store.clear('k');
  expect(open(store)).toEqual(['Offline']);
  store.clearAll();
  expect(open(store)).toEqual([]);
  expect(store.list()).toHaveLength(2);
  vi.advanceTimersByTime(400);
  expect(store.list()).toEqual([]);
});

it('holds a toast that arrives during a pause until the pause ends', () => {
  const store = createToasts();

  store.pause('away');
  store.show({ text: 'While away' });
  vi.advanceTimersByTime(60_000);
  expect(open(store)).toEqual(['While away']);
  store.resume('away');
  vi.advanceTimersByTime(5000);
  expect(open(store)).toEqual([]);
});

it('never evicts a toast that stands for a state while an error can go instead', () => {
  const store = createToasts();

  store.show({ key: 'state', tone: 'warn', text: 'Out of step', ttl: null, dismissible: false });

  for (const text of ['a', 'b', 'c', 'd']) store.show({ tone: 'error', text });

  expect(open(store)).toEqual(['Out of step', 'b', 'c', 'd']);
});

it('calls onClose only when the toast is answered, never when evicted or cleared', () => {
  const store = createToasts();
  const guard = vi.fn();

  store.show({ key: 'player', tone: 'error', text: 'Music.app refused', onClose: guard });

  for (const text of ['a', 'b', 'c', 'd']) store.show({ tone: 'error', text });

  expect(open(store)).toEqual(['Music.app refused', 'b', 'c', 'd']);

  for (const text of ['e', 'f', 'g', 'h']) store.show({ tone: 'error', text });

  store.clear('error:h');
  store.clearAll();
  expect(guard).not.toHaveBeenCalled();

  store.show({ key: 'x', text: 'Read', onClose: guard });
  store.dismiss(store.list().find((toast) => toast.key === 'x')!.id);
  expect(guard).toHaveBeenCalledOnce();
});
