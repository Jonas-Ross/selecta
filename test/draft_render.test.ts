// Controlled DOM: verify node lifetime across the async edit lifecycle without
// a browser or Music.app. Replacing moving nodes cancels their animations.
import { expect, it, vi } from 'vitest';
import { renderDraft } from '../ui/render.js';
import { elementLookup } from './dom.js';

it('keeps reordered row nodes alive when async context delivery finishes', () => {
  const el = elementLookup();
  const draft = {
    draft_id: 'draft',
    revision: 1,
    name: 'Fixture',
    feedback: '',
    save: undefined as { status: string } | undefined,
    selected_entry_ids: [] as string[],
    entries: [
      { entry_id: 'a', track_id: 'same' },
      { entry_id: 'b', track_id: 'same' },
    ],
  };
  const edit = vi.fn();
  const lanes = { tempo: false, key: false };
  let busy = false;
  const render = () =>
    renderDraft(el, {
      draft,
      inspection: undefined,
      inspection_error: undefined,
      busy,
      lanes,
      edit,
    });

  render();
  expect(el('feedback-toggle').textContent).toBe('Feedback on the playlist');
  expect(el('feedback-label').textContent).toBe('Feedback on the whole playlist');
  expect(el('timeline-note').textContent).toBe('Inspection unavailable.');
  draft.selected_entry_ids = ['b'];
  render();
  expect(el('feedback-toggle').textContent).toBe('Feedback on 1 track');
  expect(el('feedback-label').textContent).toBe('Feedback on 02 · this track');
  expect(el('timeline').children.map((node) => node.attributes['aria-pressed'])).toEqual([
    'false',
    'true',
  ]);
  el('feedback-panel').hidden = false;
  render();
  expect(el('feedback-toggle').textContent).toBe('Hide feedback');
  el('feedback-panel').hidden = true;
  draft.selected_entry_ids = ['a', 'b'];
  render();
  expect(el('feedback-toggle').textContent).toBe('Feedback on 2 tracks');
  expect(el('feedback-label').textContent).toBe('Feedback on tracks 01, 02');
  draft.selected_entry_ids = ['b'];
  expect(
    el('tracks')
      .querySelectorAll()
      .filter((node) => node.tag === 'button'),
  ).toHaveLength(4);
  const idleDisabled = el('tracks')
    .querySelectorAll()
    .map((node) => node.disabled);

  el('feedback').value = 'Unsaved feedback';
  busy = true;
  render();
  expect(el('editor').inert).toBe(true);
  expect(el('feedback').value).toBe('Unsaved feedback');
  expect(
    el('tracks')
      .querySelectorAll()
      .map((node) => node.disabled),
  ).toEqual(idleDisabled);
  expect(el('send').disabled).toBe(false);
  draft.entries.reverse();
  draft.revision++;
  render();
  const movingRows = [...el('tracks').children];

  busy = false;
  render();
  expect(el('editor').inert).toBe(false);
  expect(el('tracks').children[0]).toBe(movingRows[0]);
  expect(el('tracks').children[1]).toBe(movingRows[1]);
  expect(el('timeline').children.map((node) => node.dataset.focus)).toEqual([
    'timeline-b',
    'timeline-a',
  ]);
  expect(el('timeline').children.map((node) => node.attributes['aria-pressed'])).toEqual([
    'true',
    'false',
  ]);
  const controls = el('tracks').querySelectorAll();

  expect(controls.filter((node) => node.tag === 'input').every((node) => !node.disabled)).toBe(
    true,
  );
  expect(controls.filter((node) => node.tag === 'button' && node.disabled)).toHaveLength(2);
  el('timeline').children[0].onclick();
  expect(edit).toHaveBeenLastCalledWith({ selected_entry_ids: [] });
  el('timeline').children[1].onclick();
  expect(edit).toHaveBeenLastCalledWith({ selected_entry_ids: ['b', 'a'] });
  el('tracks').querySelectorAll()[0].onchange();
  expect(edit).toHaveBeenLastCalledWith({ selected_entry_ids: [] });
  // A pending save disables controls in place; the rendered nodes survive.
  const timelineButtons = [...el('timeline').children];

  draft.save = { status: 'pending' };
  render();
  expect(el('timeline').children).toEqual(timelineButtons);
  expect(el('timeline').children.every((node) => node.disabled)).toBe(true);
  expect(el('feedback').disabled).toBe(true);
  draft.save = undefined;
  render();
  expect(el('timeline').children.every((node) => !node.disabled)).toBe(true);
  // Lane toggles are view state: they flip classes without rebuilding blocks.
  lanes.tempo = true;
  render();
  expect(el('timeline').classes.has('show-tempo')).toBe(true);
  expect(el('timeline').classes.has('show-key')).toBe(false);
  expect(el('timeline').children).toEqual(timelineButtons);
});
