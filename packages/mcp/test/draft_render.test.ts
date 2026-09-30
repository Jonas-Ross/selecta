// Controlled DOM: verify node lifetime across the async edit lifecycle without
// a browser or Music.app. Replacing moving nodes cancels their animations.
import { expect, it, vi } from 'vitest';
import { renderDraft } from '../ui/render.js';
import { elementLookup } from './dom.js';

it('updates row and timeline nodes in place across selection, reorder and busy renders', () => {
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
  const [rowA, rowB] = el('tracks').children;
  const [blockA, blockB] = el('timeline').children;

  expect(rowA.classes.has('selected')).toBe(false);
  draft.selected_entry_ids = ['b'];
  render();
  expect(el('feedback-toggle').textContent).toBe('Feedback on 1 track');
  expect(el('feedback-label').textContent).toBe('Feedback on 02 · this track');
  // Selection is painted onto the nodes that already exist.
  expect(el('tracks').children).toEqual([rowA, rowB]);
  expect(rowB.classes.has('selected')).toBe(true);
  expect(rowB.children[0].checked).toBe(true);
  expect(el('timeline').children).toEqual([blockA, blockB]);
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
      .controls()
      .filter((node) => node.tag === 'button'),
  ).toHaveLength(4);
  const idleDisabled = el('tracks')
    .controls()
    .map((node) => node.disabled);

  el('feedback').value = 'Unsaved feedback';
  busy = true;
  render();
  expect(el('editor').inert).toBe(true);
  expect(el('feedback').value).toBe('Unsaved feedback');
  expect(
    el('tracks')
      .controls()
      .map((node) => node.disabled),
  ).toEqual(idleDisabled);
  expect(el('send').disabled).toBe(false);
  draft.entries.reverse();
  draft.revision++;
  render();
  // A reorder moves the existing nodes instead of rebuilding them.
  expect(el('tracks').children).toEqual([rowB, rowA]);
  expect(el('timeline').children).toEqual([blockB, blockA]);
  expect(rowB.children[1].textContent).toBe('01');
  busy = false;
  render();
  expect(el('editor').inert).toBe(false);
  expect(el('tracks').children).toEqual([rowB, rowA]);
  expect(el('timeline').children.map((node) => node.dataset.entryId)).toEqual(['b', 'a']);
  expect(el('timeline').children.map((node) => node.attributes['aria-pressed'])).toEqual([
    'true',
    'false',
  ]);
  const controls = el('tracks').controls();

  expect(controls.filter((node) => node.tag === 'input').every((node) => !node.disabled)).toBe(
    true,
  );
  expect(controls.filter((node) => node.tag === 'button' && node.disabled)).toHaveLength(2);
  el('timeline').children[0].onclick();
  expect(edit).toHaveBeenLastCalledWith({ selected_entry_ids: [] });
  el('timeline').children[1].onclick();
  expect(edit).toHaveBeenLastCalledWith({ selected_entry_ids: ['b', 'a'] });
  el('tracks').controls()[0].onchange();
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
  // An entry the agent removed takes its nodes with it; a new one gets fresh nodes.
  draft.entries = [draft.entries[0], { entry_id: 'c', track_id: 'other' }];
  render();
  expect(el('tracks').children[0]).toBe(rowB);
  expect(el('tracks').children[1]).not.toBe(rowA);
  expect(el('tracks').children.map((row) => row.dataset.entryId)).toEqual(['b', 'c']);
  expect(el('timeline').children.map((node) => node.dataset.entryId)).toEqual(['b', 'c']);
  expect(rowA.parentNode).toBeNull();
  // The repeat badge follows the data: b is no longer a repeated track.
  expect(rowB.children[2].children[0].children[1].textContent).toBe('');
});
