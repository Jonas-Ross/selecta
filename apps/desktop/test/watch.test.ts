import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { DraftStore } from '@selecta/core/drafts/store.js';
import { watchDrafts } from '../src/host/watch.js';

const dir = mkdtempSync(join(tmpdir(), 'selecta-watch-'));
const path = join(dir, 'drafts.db');
const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();

  rmSync(dir, { recursive: true, force: true });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

it('fires when the store appears and when another process commits', async () => {
  const onChange = vi.fn();

  stops.push(watchDrafts(path, onChange, 10));
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
