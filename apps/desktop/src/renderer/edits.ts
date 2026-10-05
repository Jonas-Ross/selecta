// The draft's edit queue. Edits run one at a time on the newest revision, so
// queued clicks compose; Save and Home wait on everything queued before them.

export type Change<D> = (draft: D) => Record<string, unknown> | undefined;

export interface EditQueue<D> {
  edit(change: Change<D>): Promise<boolean>;
  after<T>(step: () => T | Promise<T>): Promise<T>;
  barrier<T>(step: () => Promise<T>): Promise<T | undefined>;
  landed(): Promise<boolean>;
}

/**
 * `latest` is the draft as last read; `send` writes one change against it and
 * resolves to whether it landed, never rejecting.
 */
export function editQueue<D>(
  latest: () => D | undefined,
  send: (base: D, args: Record<string, unknown>) => Promise<boolean>,
): EditQueue<D> {
  let tail: Promise<unknown> = Promise.resolve();
  const inflight = new Set<Promise<boolean>>();

  function after<T>(step: () => T | Promise<T>): Promise<T> {
    const next = tail.then(step);

    tail = next.catch(() => undefined);

    return next;
  }

  return {
    // A change is worked out from the draft as it stands when its turn comes, so
    // queued clicks compose instead of replaying the snapshot they were made on.
    edit(change) {
      const next = after(() => {
        const base = latest();
        const args = base && change(base);

        return !base || !args ? true : send(base, args);
      });
      const drop = () => inflight.delete(next);

      inflight.add(next);
      next.then(drop, drop);

      return next;
    },
    after,
    // Runs once the edits queued so far settle, and only if every one landed.
    barrier(step) {
      const ahead = [...inflight];

      return after(() =>
        Promise.all(ahead).then((landed) => (landed.every(Boolean) ? step() : undefined)),
      );
    },
    landed: () => Promise.all(inflight).then((landed) => landed.every(Boolean)),
  };
}

/** Shows a value until its landing settles; an older landing never clears a newer value. */
export function newestHold<T>(set: (value: T | undefined) => void) {
  let token = 0;

  return (value: T, landing: Promise<unknown>) => {
    const mine = ++token;
    const clear = () => token === mine && set(undefined);

    set(value);
    landing.then(clear, clear);
  };
}
