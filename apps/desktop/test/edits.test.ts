import { expect, it, vi } from 'vitest';
import { editQueue, newestHold } from '../src/renderer/edits.js';

type Draft = { revision: number; entries: string[] };

// A store that applies each edit's entries on the revision it was made against.
function store(start: string[], refuse = new Set<number>()) {
  let draft: Draft = { revision: 1, entries: start };
  const sent: { revision: number; args: Record<string, unknown> }[] = [];
  let release: (() => void) | undefined;
  const queue = editQueue<Draft>(
    () => draft,
    async (base, args) => {
      sent.push({ revision: base.revision, args });
      await new Promise<void>((resolve) => (release = resolve));

      if (refuse.has(base.revision)) return false;

      draft = { revision: base.revision + 1, entries: args.entries as string[] };

      return true;
    },
  );
  const settle = async () => {
    await vi.waitFor(() => expect(release).toBeDefined());
    const go = release!;

    release = undefined;
    go();
  };

  return { queue, sent, settle, draft: () => draft };
}

it('works each queued change out from the draft as the edit before it left it', async () => {
  const { queue, sent, settle, draft } = store(['a', 'b', 'c']);

  const first = queue.edit((d) => ({ entries: d.entries.filter((e) => e !== 'a') }));
  const second = queue.edit((d) => ({ entries: [...d.entries].reverse() }));

  await settle();
  expect(await first).toBe(true);
  await settle();
  expect(await second).toBe(true);
  expect(sent.map((s) => s.revision)).toEqual([1, 2]);
  expect(draft().entries).toEqual(['c', 'b']);
});

it('skips a change that has nothing to write once its turn comes', async () => {
  const { queue, sent } = store(['a']);

  expect(await queue.edit(() => undefined)).toBe(true);
  expect(sent).toEqual([]);
});

it('runs a save only after every edit queued before it landed', async () => {
  const { queue, settle } = store(['a', 'b']);
  const commit = vi.fn(async () => 'saved');

  void queue.edit((d) => ({ entries: [...d.entries].reverse() }));

  const saving = queue.barrier(commit);

  expect(commit).not.toHaveBeenCalled();
  await settle();
  expect(await saving).toBe('saved');
});

it('skips the save when an edit before it failed, and the draft stays as stored', async () => {
  const { queue, settle, draft } = store(['a', 'b'], new Set([1]));
  const commit = vi.fn(async () => 'saved');

  const failed = queue.edit((d) => ({ entries: [...d.entries].reverse() }));
  const saving = queue.barrier(commit);

  await settle();
  expect(await failed).toBe(false);
  expect(await saving).toBeUndefined();
  expect(commit).not.toHaveBeenCalled();
  expect(draft()).toEqual({ revision: 1, entries: ['a', 'b'] });
});

it('reports whether everything pending has landed, for leaving the draft', async () => {
  const { queue, settle } = store(['a', 'b'], new Set([1]));

  void queue.edit((d) => ({ entries: [...d.entries].reverse() }));

  const landed = queue.landed();

  await settle();
  expect(await landed).toBe(false);
  expect(await queue.landed()).toBe(true);
});

it('keeps the newest held order until its own landing settles', async () => {
  const set = vi.fn();
  const hold = newestHold<string[]>(set);
  let first!: () => void;
  let second!: () => void;

  hold(['b', 'a'], new Promise<void>((resolve) => (first = resolve)));
  hold(['a', 'b'], new Promise<void>((resolve) => (second = resolve)));
  first();
  await Promise.resolve();
  await Promise.resolve();
  expect(set).toHaveBeenLastCalledWith(['a', 'b']);
  second();
  await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(undefined));
});
