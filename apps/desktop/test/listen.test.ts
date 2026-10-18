import { expect, it, vi } from 'vitest';
import { editQueue } from '../src/renderer/edits.js';
import {
  asked,
  elsewhere,
  joinStart,
  livePosition,
  nowIndex,
  afterEdits,
  setClock,
} from '../src/renderer/listen.js';
import type { Row } from '../src/renderer/state.js';

const row = (entry_id: string, extra: Partial<Row> = {}): Row => ({
  entry_id,
  track_id: `T${entry_id}`,
  ...extra,
});
const items = [
  row('a', { duration_seconds: 300 }),
  row('b', { duration_seconds: 240 }),
  row('c'),
  row('d', { duration_seconds: 200 }),
];

it('starts the join early enough for AutoMix, never before the track', () => {
  expect(joinStart(300, 60)).toBe(240);
  expect(joinStart(300, 25)).toBe(275);
  expect(joinStart(30, 60)).toBe(0);
  expect(joinStart(undefined, 60)).toBeUndefined();
  expect(joinStart(0, 60)).toBeUndefined();
});

it('centres on the playing entry, else the cued one, else the first', () => {
  const player = { running: true, state: 'playing' as const, entry_id: 'c' };

  expect(nowIndex(items, player, 'b')).toBe(2);
  expect(nowIndex(items, { running: true, state: 'paused' }, 'b')).toBe(1);
  expect(nowIndex(items, { ...player, entry_id: 'gone' }, 'gone')).toBe(0);
  expect(nowIndex(items, undefined)).toBe(0);
});

it('moves a playing position on between reads, and holds a paused one', () => {
  const read = { running: true, state: 'playing' as const, position: 10, duration: 12 };

  expect(livePosition(read, 1000, 2500)).toBe(11.5);
  expect(livePosition(read, 1000, 9000)).toBe(12);
  expect(livePosition({ ...read, state: 'paused' }, 1000, 9000)).toBe(10);
  expect(livePosition(undefined, 0, 1000)).toBe(0);
  // Music.app's unset length of 0 doesn't pin the clock to the start.
  expect(livePosition({ ...read, duration: 0 }, 1000, 2500)).toBe(11.5);
  // A play Music hasn't confirmed yet doesn't run ahead of where it will start.
  expect(livePosition({ ...read, pending: true }, 1000, 2500)).toBe(10);
});

it('counts set time from the lengths before, flagging an unknown one', () => {
  expect(setClock(items, 1, 30)).toEqual({ elapsed: 330, partial: false });
  expect(setClock(items, 3, 0)).toEqual({ elapsed: 540, partial: true });
});

it('says why the player is not showing this draft', () => {
  expect(elsewhere({ running: false, state: 'stopped' })).toBe('Music is closed');
  expect(elsewhere({ running: true, state: 'playing', track_id: 'X' })).toMatch(/outside/);
  expect(elsewhere({ running: true, state: 'playing', entry_id: 'a' })).toBeUndefined();
  expect(elsewhere({ running: true, state: 'stopped' })).toBeUndefined();
  expect(elsewhere(undefined)).toBeUndefined();
});

it('calls once the queued edits land, unless calling stopped being allowed meanwhile', async () => {
  let draft = { revision: 1 };
  let allowed = true;
  const queue = editQueue(
    () => draft,
    async () => {
      draft = { revision: draft.revision + 1 };

      return true;
    },
  );
  const play = vi.fn(async () => draft.revision);

  void queue.edit(() => ({ order: [] }));
  await expect(afterEdits(queue, () => allowed, play)).resolves.toBe(2);

  // Claude started while an edit ahead of the play was still landing.
  void queue.edit(() => {
    allowed = false;

    return { order: [] };
  });
  await expect(afterEdits(queue, () => allowed, play)).resolves.toBeUndefined();
  expect(play).toHaveBeenCalledOnce();

  // An edit behind the call doesn't wait for Music to answer it.
  let answer!: (value: number) => void;
  const slow = afterEdits(
    queue,
    () => true,
    () => new Promise<number>((r) => (answer = r)),
  );
  const edited = queue.edit(() => ({ order: [] }));

  await expect(edited).resolves.toBe(true);
  answer(7);
  await expect(slow).resolves.toBe(7);
});

it('shows what each transport action asks for, and stops only a draft that is playing', () => {
  const on = {
    running: true,
    state: 'playing' as const,
    entry_id: 'b',
    position: 10,
    duration: 200,
  };

  expect(asked.play('c', 30)).toEqual({
    running: true,
    state: 'playing',
    entry_id: 'c',
    position: 30,
  });
  expect(asked.play('c').position).toBe(0);
  // A pause holds the position the bar had moved on to.
  expect(asked.pause(on, 1000, 3000)).toEqual({ ...on, state: 'paused', position: 12 });
  expect(asked.resume({ ...on, state: 'paused' })).toEqual(on);
  expect(asked.seek(on, 150)).toEqual({ ...on, position: 150 });
  expect(asked.stop(on)).toEqual({ ...on, state: 'paused' });
  // Music on something else keeps playing it.
  const elsewhere = { running: true, state: 'playing' as const, track_id: 'X' };

  expect(asked.stop(elsewhere)).toBe(elsewhere);
  expect(asked.pause(undefined, 0, 0)).toBeUndefined();
});
