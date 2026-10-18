import { expect, it, vi } from 'vitest';
import type { Playback, PlaybackView } from '@selecta/core/operations/playback.js';
import { createMusicLane } from '../src/host/music.js';

// A Playback whose calls each wait for the test to let them finish, recording what Music was asked.
function fakePlayer() {
  const calls: string[] = [];
  const gates: (() => void)[] = [];
  let view: PlaybackView = { running: true, state: 'stopped' };
  const step = <T>(name: string, after: () => T): Promise<T> => {
    calls.push(name);

    return new Promise((resolve) => gates.push(() => resolve(after())));
  };
  const player = {
    play: (_draft: string, entry: string, position?: number) =>
      step(`play ${entry}@${position ?? 0}`, () => {
        view = { running: true, state: 'playing', entry_id: entry, position: position ?? 0 };

        return view;
      }),
    control: (_draft: string, input: { action: string; position?: number }) =>
      step(`${input.action}${input.position === undefined ? '' : ` ${input.position}`}`, () => {
        if (input.action === 'pause') view = { ...view, state: 'paused' };

        if (input.action === 'resume') view = { ...view, state: 'playing' };

        if (input.action === 'seek') view = { ...view, position: input.position };

        return view;
      }),
    state: () => step('read', () => view),
    detach: () => step('detach', () => undefined),
    audition: (ids: string[], index: number) =>
      step(`audition ${ids[index]}`, () => ({ state: 'playing' as const, index })),
    auditionState: () => step('heard', () => ({ state: 'stopped' as const })),
    stopAudition: () => step('stop audition', () => undefined),
  } as unknown as Playback;
  // Lets the oldest waiting call finish, then lets the lane start the next.
  const finish = async () => {
    gates.shift()!();
    await new Promise((resolve) => setTimeout(resolve));
  };
  const settle = async () => {
    while (gates.length) await finish();
  };

  return { player, calls, finish, settle };
}

const setup = () => {
  const music = fakePlayer();
  let revision = 1;
  const lane = createMusicLane({
    player: music.player,
    syncLinked: async (draftId) => {
      music.calls.push(`sync ${draftId} r${revision}`);
    },
  });

  return { ...music, lane, edit: () => revision++ };
};

it('runs one call at a time, in the order asked', async () => {
  const { lane, calls, finish, settle } = setup();
  const played = lane.play('D', 'a');
  const sought = lane.after('test', async () => calls.push('save'));

  expect(calls).toEqual(['play a@0']);
  await finish();
  await settle();
  await expect(played).resolves.toMatchObject({ entry_id: 'a', state: 'playing' });
  await sought;
  expect(calls).toEqual(['play a@0', 'save']);
});

it('folds a burst of clicks into the one step the newest asks for', async () => {
  const { lane, calls, settle } = setup();
  const first = lane.play('D', 'a');
  // Waiting behind the first play: next, next, next, then a seek into the last.
  const waiting = [
    lane.play('D', 'b'),
    lane.play('D', 'c'),
    lane.play('D', 'd'),
    lane.seek('D', 90),
  ];

  await settle();
  await first;
  expect(calls).toEqual(['play a@0', 'play d@90']);

  // Every caller hears how the step they were folded into ended.
  for (const call of await Promise.all(waiting))
    expect(call).toMatchObject({ entry_id: 'd', position: 90 });
});

it('cancels a pause and resume that meet while waiting, and still plays a play paused while waiting', async () => {
  const { lane, calls, settle } = setup();

  void lane.play('D', 'a');
  void lane.pause('D');
  void lane.resume('D');
  await settle();
  // Nothing left to do, so the play's answer stands.
  expect(calls).toEqual(['play a@0']);

  calls.length = 0;
  void lane.pause('D');
  void lane.play('D', 'b');
  void lane.pause('D');
  await settle();
  // Music ends paused on the record the screen shows, not on the one it was paused on.
  expect(calls).toEqual(['pause', 'play b@0', 'pause']);

  calls.length = 0;
  void lane.play('D', 'c');
  void lane.play('D', 'd');
  void lane.pause('D');
  const last = lane.resume('D');

  await settle();
  expect(calls).toEqual(['play c@0', 'play d@0']);
  await expect(last).resolves.toMatchObject({ entry_id: 'd', state: 'playing' });
});

it("doesn't pause a draft that isn't playing", async () => {
  const { lane, calls, settle } = setup();

  void lane.state('D');
  void lane.pause('D');
  await settle();
  expect(calls).toEqual(['read']);
});

it('seeks after a pause and before a resume', async () => {
  const { lane, calls, settle } = setup();

  void lane.play('D', 'a');
  void lane.pause('D');
  void lane.seek('D', 40);
  await settle();
  expect(calls).toEqual(['play a@0', 'pause', 'seek 40']);

  calls.length = 0;
  void lane.state('D');
  void lane.resume('D');
  void lane.seek('D', 80);
  await settle();
  expect(calls).toEqual(['read', 'seek 80', 'resume']);
});

it("never merges past a call queued after it, so a stop isn't overtaken", async () => {
  const { lane, calls, settle } = setup();

  void lane.play('D', 'a');
  void lane.after('test', async () => calls.push('save'));
  void lane.seek('D', 30);
  await settle();
  expect(calls).toEqual(['play a@0', 'save', 'seek 30']);
});

it('drops what a draft still waits to play when it stops', async () => {
  const { lane, calls, settle } = setup();

  void lane.state('D');
  const waiting = lane.play('D', 'a');

  void lane.detach('D', 1);
  await settle();
  await expect(waiting).resolves.toBeUndefined();
  expect(calls).toEqual(['read', 'detach']);
});

it('syncs again for an edit queued behind a waiting sync', async () => {
  const { lane, calls, settle, edit } = setup();

  void lane.play('D', 'a');
  void lane.sync('D');
  void lane.after('edit', async () => edit(), 'D');
  void lane.sync('D');
  await settle();
  expect(calls).toEqual(['play a@0', 'sync D r1', 'sync D r2']);
});

it('says while something for a draft is playing, writing or waiting to', async () => {
  const { lane, settle } = setup();

  void lane.play('D', 'a');
  expect(lane.holds('D')).toBe(true);
  expect(lane.holds('E')).toBe(false);
  await settle();
  expect(lane.holds('D')).toBe(false);
});

it('drops a sync still waiting when its draft stops', async () => {
  const { lane, calls, settle } = setup();

  void lane.play('D', 'a');
  void lane.sync('D');
  void lane.detach('D', 1);
  await settle();
  expect(calls).toEqual(['play a@0', 'detach']);
});

it('moves a cached playing answer on with the clock', async () => {
  const { lane, settle } = setup();
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);

  void lane.play('D', 'a', 10);
  await settle();
  void lane.after('test', async () => {});
  now.mockReturnValue(4_000);
  await expect(lane.state('D')).resolves.toMatchObject({ entry_id: 'a', position: 13 });
  now.mockRestore();
  await settle();
});

it('syncs a burst of linked edits once, after what was asked before them', async () => {
  const { lane, calls, settle, edit } = setup();

  void lane.play('D', 'a');
  edit();
  void lane.sync('D');
  expect(lane.syncing('D')).toBe(true);
  edit();
  void lane.sync('D');
  await settle();
  expect(calls).toEqual(['play a@0', 'sync D r3']);
  expect(lane.syncing('D')).toBe(false);
});

it('answers polls from the last call while busy, and reads Music when idle', async () => {
  const { lane, calls, settle } = setup();

  void lane.play('D', 'a');
  await settle();
  void lane.play('D', 'b');
  await expect(lane.state('D')).resolves.toMatchObject({ entry_id: 'a' });
  await settle();
  void lane.state('D');
  await settle();
  expect(calls).toEqual(['play a@0', 'play b@0', 'read']);
});

it('auditions only the newest of a burst, and a stop drops one still waiting', async () => {
  const { lane, calls, settle } = setup();

  void lane.audition(['x', 'y'], 0);
  void lane.audition(['x', 'y'], 1);
  void lane.audition(['x', 'z'], 1);
  await settle();
  expect(calls).toEqual(['audition x', 'audition z']);

  calls.length = 0;
  void lane.audition(['x', 'y'], 0);
  const waiting = lane.audition(['x', 'y'], 1);

  void lane.auditionStop();
  await settle();
  await expect(waiting).resolves.toEqual({ state: 'stopped' });
  expect(calls).toEqual(['audition x', 'stop audition']);
});

it('keeps going after a call fails, failing only its own callers', async () => {
  const { lane, calls } = setup();
  const failing = lane.after('test', async () => {
    throw new Error('Music is closed');
  });
  const next = lane.after('test', async () => calls.push('next'));

  await expect(failing).rejects.toThrow('Music is closed');
  await next;
  expect(calls).toEqual(['next']);
});

it('logs each step Music took, with how many calls it answered, and skips idle reads', async () => {
  const music = fakePlayer();
  const steps: { step: string; calls: number; error?: string }[] = [];
  const lane = createMusicLane({
    player: music.player,
    syncLinked: async () => {},
    log: ({ step, calls, error }) => steps.push({ step, calls, ...(error && { error }) }),
  });

  void lane.state('D');
  void lane.play('D', 'a');
  void lane.play('D', 'b');
  void lane.seek('D', 20);
  await music.settle();
  await lane.after('save', async () => {}).catch(() => {});
  expect(steps).toEqual([
    { step: 'play b at 20', calls: 3 },
    { step: 'save', calls: 1 },
  ]);
});
