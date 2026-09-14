import { afterEach, expect, it, vi } from 'vitest';
import { watchDraftFreshness } from '../ui/draft-freshness.js';
afterEach(() => vi.useRealTimers());
it('paces continuous reads, pauses when hidden, resumes on visibility and disposes', async () => {
  vi.useFakeTimers();
  let visible = true;
  const read = vi.fn(async () => {});
  const watcher = watchDraftFreshness({ read, active: () => visible, failed: vi.fn() });

  watcher.resume();
  await vi.advanceTimersByTimeAsync(303000);
  expect(read).toHaveBeenCalledTimes(101);
  visible = false;
  watcher.resume();
  await vi.advanceTimersByTimeAsync(6000);
  expect(read).toHaveBeenCalledTimes(101);
  visible = true;
  watcher.resume();
  await vi.advanceTimersByTimeAsync(3000);
  expect(read).toHaveBeenCalledTimes(102);
  watcher.dispose();
  watcher.resume();
  await vi.advanceTimersByTimeAsync(9000);
  expect(read).toHaveBeenCalledTimes(102);
});
it('stops on failure without automatic retries or overlapping reads', async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const read = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const failed = vi.fn();
  const watcher = watchDraftFreshness({ read, active: () => true, failed });

  watcher.resume();
  await vi.advanceTimersByTimeAsync(3000);
  watcher.resume();
  await vi.advanceTimersByTimeAsync(30000);
  expect(read).toHaveBeenCalledTimes(1);
  reject(new Error('offline'));
  await vi.advanceTimersByTimeAsync(30000);
  expect(read).toHaveBeenCalledTimes(1);
  expect(failed).toHaveBeenCalledOnce();
  watcher.resume();
  await vi.advanceTimersByTimeAsync(3000);
  expect(read).toHaveBeenCalledTimes(1);
  watcher.dispose();
});
