import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeDraftStore } from './helpers.js';

it('lists nothing before any draft is written', () => {
  expect(makeDraftStore().list()).toEqual([]);
});

it('lists nothing when only preferences exist', () => {
  const drafts = makeDraftStore();

  drafts.appearance('moss');

  expect(drafts.list()).toEqual([]);
});

it('lists drafts newest first with counts and save attempts', () => {
  const drafts = makeDraftStore();
  const first = drafts.create(randomUUID(), 'Warmup', ['A', 'B']);
  const second = drafts.create(randomUUID(), 'Peak', ['C', 'C', 'D']);

  drafts.update(first.draft_id, 1, (draft) => ({
    ...draft,
    save: { revision: 1, status: 'finished', result: { error: 'jxa_error' } },
  }));

  expect(drafts.list()).toEqual([
    {
      draft_id: second.draft_id,
      name: 'Peak',
      revision: 1,
      track_count: 3,
    },
    {
      draft_id: first.draft_id,
      name: 'Warmup',
      revision: 2,
      track_count: 2,
      save: { revision: 1, status: 'finished', result: { error: 'jxa_error' } },
    },
  ]);
});
