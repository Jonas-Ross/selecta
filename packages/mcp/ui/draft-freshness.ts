/** Rate-bounded cache-only reads. Failures pause until an explicit reload. */
export function watchDraftFreshness({
  read,
  active,
  failed,
  interval = 3000,
}: {
  read: () => Promise<void>;
  active: () => boolean;
  failed: (error: unknown) => void;
  interval?: number;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let running = false;
  let paused = false;
  const schedule = () => {
    if (!disposed && !paused) timer = setTimeout(() => void tick(), interval);
  };

  async function tick() {
    if (disposed || running || !active()) return;

    running = true;

    try {
      await read();
      schedule();
    } catch (error) {
      paused = true;

      if (!disposed) failed(error);
    } finally {
      running = false;
    }
  }

  function resume(explicit = false) {
    if (disposed || running) return;

    if (explicit) paused = false;

    clearTimeout(timer);
    schedule();
  }

  function dispose() {
    disposed = true;
    clearTimeout(timer);
  }

  return { resume, dispose };
}
