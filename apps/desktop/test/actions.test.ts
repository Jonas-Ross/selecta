import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createActionLog } from '../src/host/actions.js';

const setup = (maxBytes?: number) => {
  const path = join(mkdtempSync(join(tmpdir(), 'actions-')), 'desktop.log');
  const log = createActionLog({ path, now: () => new Date('2026-10-03T20:00:00Z'), maxBytes });
  const lines = () =>
    existsSync(path)
      ? readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];

  return { path, log, lines };
};

it('records actions with their outcome, and player results', async () => {
  const { log, lines } = setup();

  await log.record('drafts.edit', { draft_id: 'D' }, async () => ({ revision: 2 }));
  await log.record('player.play', { draft_id: 'D' }, async () => ({ state: 'playing' }));
  await expect(
    log.record('player.pause', { draft_id: 'D' }, async () => {
      throw new Error('Music.app has moved off that record.');
    }),
  ).rejects.toThrow();

  expect(lines()).toEqual([
    {
      at: '2026-10-03T20:00:00.000Z',
      method: 'drafts.edit',
      args: { draft_id: 'D' },
      ms: expect.any(Number),
    },
    expect.objectContaining({ method: 'player.play', result: { state: 'playing' } }),
    expect.objectContaining({
      method: 'player.pause',
      error: 'Music.app has moved off that record.',
    }),
  ]);
});

it('leaves out polled reads unless they fail or the player changes', async () => {
  const { log, lines } = setup();
  const state = (entry_id: string, position: number) =>
    log.record('player.state', { draft_id: 'D' }, async () => ({
      state: 'playing',
      entry_id,
      position,
    }));

  await log.record('drafts.get', { draft_id: 'D' }, async () => ({}));
  await state('E1', 1);
  await state('E1', 2);
  await state('E2', 0);
  await log
    .record('drafts.get', { draft_id: 'D' }, async () => {
      throw new Error('gone');
    })
    .catch(() => {});

  expect(lines().map((line) => [line.method, line.result?.entry_id ?? line.error])).toEqual([
    ['player.state', 'E1'],
    ['player.state', 'E2'],
    ['drafts.get', 'gone'],
  ]);
});

it('keeps one previous file once the log grows past its limit', async () => {
  const { path, log, lines } = setup(10);

  writeFileSync(path, 'x'.repeat(20));
  log.note('agent', { kind: 'done' });

  expect(readFileSync(`${path}.1`, 'utf8')).toBe('x'.repeat(20));
  expect(lines()).toEqual([expect.objectContaining({ event: 'agent', kind: 'done' })]);
});
