import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DraftStore } from '@selecta/core/drafts/store.js';
import { watchDrafts } from '../src/host/watch.js';

let dir: string;
let path: string;
const stops: (() => void)[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'selecta-watch-'));
  path = join(dir, 'drafts.db');
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();

  rmSync(dir, { recursive: true, force: true });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

it('fires when the store appears and when another process commits', async () => {
  const onChange = vi.fn();

  stops.push(watchDrafts(path, onChange, () => {}, 10));
  await tick();
  expect(onChange).not.toHaveBeenCalled();

  const store = new DraftStore(path);
  const draft = store.create(randomUUID(), 'Warmup', ['A']);

  await tick();
  expect(onChange).toHaveBeenCalledTimes(1);

  await tick();
  expect(onChange).toHaveBeenCalledTimes(1);

  store.update(draft.draft_id, 1, (current) => ({ ...current, name: 'Peak' }));
  await tick();
  expect(onChange).toHaveBeenCalledTimes(2);
});

it('reports an unreadable store once and recovers when it becomes readable', async () => {
  const onChange = vi.fn();
  const onError = vi.fn();

  writeFileSync(path, 'not a sqlite database, just bytes '.repeat(200));
  stops.push(watchDrafts(path, onChange, onError, 10));
  await tick();
  await tick();
  expect(onError).toHaveBeenCalledTimes(1);

  rmSync(path);
  new DraftStore(path).create(randomUUID(), 'Warmup', ['A']);
  await tick();
  expect(onChange).toHaveBeenCalled();
});
