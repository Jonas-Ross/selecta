import { expect, it, vi } from 'vitest';
import { editQueue } from '../src/renderer/edits.js';
import {
  elsewhere,
  joinStart,
  transportHeld,
  livePosition,
  nowIndex,
  queuePlay,
  setClock,
  wheelCell,
  wheelPoint,
  wheelRoute,
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
  expect(joinStart(300)).toBe(240);
  expect(joinStart(30)).toBe(0);
  expect(joinStart(undefined)).toBeUndefined();
  expect(joinStart(0)).toBeUndefined();
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

it('places keys on the wheel like a clock, minor inside major', () => {
  expect(wheelPoint('12B')).toEqual([0, -106]);
  expect(wheelPoint('12B', 'label')).toEqual([0, -124]);
  expect(wheelPoint('3A')![0]).toBeCloseTo(64);
  expect(wheelPoint('3A')![1]).toBeCloseTo(0);
  expect(wheelPoint('13A')).toBeUndefined();
  expect(wheelPoint(undefined)).toBeUndefined();
  expect(wheelCell(12, 'A')).toMatch(/^M.*A92 92 0 0 1 .*A52 52 0 0 0 .*Z$/);
});

it('draws the route through the wheel, lifting the pen at a missing key', () => {
  expect(wheelRoute(['12B', '12A'], 0, 1)).toBe('M0.0 -106.0L0.0 -64.0');
  expect(wheelRoute(['12B', undefined, '12A'], 0, 2)).toBe('M0.0 -106.0M0.0 -64.0');
  expect(wheelRoute(['12B', '12A'], 1, 5)).toBe('M0.0 -64.0');
});

it('plays on the revision the queued edits leave, unless play stopped being allowed meanwhile', async () => {
  let draft = { revision: 1 };
  let allowed = true;
  const queue = editQueue(
    () => draft,
    async () => {
      draft = { revision: draft.revision + 1 };

      return true;
    },
  );
  const play = vi.fn();

  void queue.edit(() => ({ order: [] }));
  await queuePlay(
    queue,
    () => allowed,
    () => draft.revision,
    play,
  );
  expect(play).toHaveBeenCalledExactlyOnceWith(2);

  // Claude started while an edit ahead of the play was still landing.
  void queue.edit(() => {
    allowed = false;

    return { order: [] };
  });
  await queuePlay(
    queue,
    () => allowed,
    () => draft.revision,
    play,
  );
  expect(play).toHaveBeenCalledOnce();
});

it('holds the transport while a linked edit syncs, as it does for a running player action', () => {
  expect(transportHeld(false, true, { order: [], known: [] })).toBe(true);
  expect(transportHeld(true, false, undefined)).toBe(true);
  // An unlinked edit never touches Music.app, so the transport stays free.
  expect(transportHeld(false, false, { order: [], known: [] })).toBe(false);
  expect(transportHeld(false, true, undefined)).toBe(false);
});
