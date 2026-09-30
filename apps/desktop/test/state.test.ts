import { expect, it } from 'vitest';
import {
  feedbackMessage,
  formatDuration,
  logAgentEvent,
  move,
  previewLinked,
  rows,
  saveLabel,
  saveOutcome,
  totalDuration,
} from '../src/renderer/state.js';

const entry = (id: string) => ({ entry_id: id, track_id: `T-${id}` });

it('lines tracks up with entries, repeats included', () => {
  expect(
    rows({
      draft: { draft_id: 'd', revision: 1, name: 'n', entries: [entry('a'), entry('b')] },
      inspection: { tracks: [{ title: 'Roads' }, { title: 'Roads' }] },
    }),
  ).toEqual([
    { ...entry('a'), title: 'Roads' },
    { ...entry('b'), title: 'Roads' },
  ]);
  expect(rows({})).toEqual([]);
});

it('moves an item without mutating the original', () => {
  const items = ['a', 'b', 'c', 'd'];

  expect(move(items, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  expect(move(items, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  expect(items).toEqual(['a', 'b', 'c', 'd']);
});

it('formats durations and marks totals with unknown lengths', () => {
  expect(formatDuration(305.4)).toBe('5:05');
  expect(formatDuration()).toBe('');
  expect(
    totalDuration([
      { ...entry('a'), duration_seconds: 300 },
      { ...entry('b'), duration_seconds: 330 },
    ]),
  ).toBe('2 tracks · 11 min');
  expect(totalDuration([{ ...entry('a'), duration_seconds: 300 }, entry('b')])).toBe(
    '2 tracks · 5 min+',
  );
});

it('names selected tracks as the subject of feedback', () => {
  expect(feedbackMessage('slower', [])).toBe('slower');
  expect(
    feedbackMessage('swap it', [{ ...entry('a'), title: 'Roads', artist: 'Portishead' }]),
  ).toBe('About these tracks:\n- Roads by Portishead (entry a)\n\nswap it');
});

it('turns agent events into log lines', () => {
  let log = logAgentEvent([], { kind: 'tool', name: 'show_playlist_draft' });

  log = logAgentEvent(log, { kind: 'text', text: 'Built it.' });
  log = logAgentEvent(log, { kind: 'denied', name: 'save_playlist_draft' });
  log = logAgentEvent(log, { kind: 'done' });

  expect(log).toEqual([
    { kind: 'tool', text: 'show playlist draft' },
    { kind: 'claude', text: 'Built it.' },
    { kind: 'error', text: 'Blocked save_playlist_draft: the app saves, not Claude.' },
  ]);
});

it('describes save outcomes in a sentence', () => {
  expect(saveOutcome({ result: { name: 'Peak', track_count: 12 } })).toBe(
    'Saved "Peak" to Music with 12 tracks.',
  );
  expect(
    saveOutcome({ result: { name: 'Peak', track_count: 12, order_matches_request: false } }),
  ).toContain('different order');
  expect(saveOutcome({ error: 'jxa_error', hint: 'Inspect Music.app.' })).toBe(
    'jxa_error Inspect Music.app.',
  );
});

it('labels the save button by what the draft recorded', () => {
  expect(saveLabel(undefined)).toBe('Save to Music');
  expect(saveLabel({ status: 'pending' })).toBe('Save pending');
  expect(saveLabel({ status: 'finished', result: { playlist_id: 'P' } })).toBe('Saved');
  expect(saveLabel({ status: 'finished', result: { error: 'jxa_error' } })).toBe('Save uncertain');
});

it('treats a draft as linked only while it owns an active preview', () => {
  const draft = {
    draft_id: 'd',
    revision: 1,
    name: 'n',
    entries: [entry('a')],
    selected_entry_ids: [],
    feedback: '',
  };

  expect(previewLinked({ draft, preview: { owner: 'd', status: 'current' } })).toBe(true);
  expect(previewLinked({ draft, preview: { owner: 'd', status: 'inactive' } })).toBe(false);
  expect(previewLinked({ draft, preview: { owner: 'other', status: 'current' } })).toBe(false);
  expect(previewLinked({ draft, preview: { status: 'inactive' } })).toBe(false);
  expect(previewLinked({})).toBe(false);
});
