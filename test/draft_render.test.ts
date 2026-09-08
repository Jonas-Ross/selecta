// Controlled DOM: verify node lifetime across the async edit lifecycle without
// a browser or Music.app. Replacing moving nodes cancels their animations.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { timelineEntries, renderTimeline, clockLabel } from '../ui/timeline.js';

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  ownerDocument = { createElement: (tag: string) => new Element(tag) };
  scrollTop = 0;
  disabled = false;
  onclick = () => {};
  inert = false;
  textContent = '';
  value = '';
  hidden = true;
  classList = { toggle() {} };
  constructor(readonly tag = 'div') {}
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  querySelectorAll() {
    return this.children.flatMap((node): Element[] => [
      ...(['input', 'button'].includes(node.tag) ? [node] : []),
      ...node.querySelectorAll(),
    ]);
  }
}

it('keeps reordered row nodes alive when async context delivery finishes', () => {
  const nodes = new Map<string, Element>();
  const el = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Element());

    return nodes.get(id)!;
  };
  const source = readFileSync(new URL('../ui/playlist-draft.js', import.meta.url), 'utf8');
  const renderSource =
    source.slice(source.indexOf('function updateTimeline()'), source.indexOf('\nfor (const lane')) +
    source.slice(source.indexOf('function render()'), source.indexOf('\nasync function action('));
  const state = {
    draft: {
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
    },
  };
  const runtime = {
    state,
    busy: false,
    el,
    document: { createElement: (tag: string) => new Element(tag) },
    duration: String,
    edit: vi.fn(),
    renderedTracks: undefined as string | undefined,
    renderedTimeline: undefined as string | undefined,
    timelineEntries,
    renderTimeline,
    clockLabel,
  };

  runInNewContext(`${renderSource}; render();`, runtime);
  expect(el('feedback-toggle').textContent).toBe('Feedback on the playlist');
  expect(el('feedback-label').textContent).toBe('Feedback on the whole playlist');
  state.draft.selected_entry_ids = ['b'];
  runInNewContext(`${renderSource}; render();`, runtime);
  expect(el('feedback-toggle').textContent).toBe('Feedback on 1 track');
  expect(el('feedback-label').textContent).toBe('Feedback on 02 · this track');
  expect(el('timeline').children.map((node) => node.attributes['aria-pressed'])).toEqual([
    'false',
    'true',
  ]);
  el('feedback-panel').hidden = false;
  runInNewContext(`${renderSource}; render();`, runtime);
  expect(el('feedback-toggle').textContent).toBe('Hide feedback');
  el('feedback-panel').hidden = true;
  state.draft.selected_entry_ids = ['a', 'b'];
  runInNewContext(`${renderSource}; render();`, runtime);
  expect(el('feedback-toggle').textContent).toBe('Feedback on 2 tracks');
  expect(el('feedback-label').textContent).toBe('Feedback on tracks 01, 02');
  state.draft.selected_entry_ids = ['b'];
  expect(
    el('tracks')
      .querySelectorAll()
      .filter((node) => node.tag === 'button'),
  ).toHaveLength(4);
  const idleDisabled = el('tracks')
    .querySelectorAll()
    .map((node) => node.disabled);

  el('feedback').value = 'Unsaved feedback';
  runtime.busy = true;
  runInNewContext(`${renderSource}; render();`, runtime);
  expect(el('editor').inert).toBe(true);
  expect(el('feedback').value).toBe('Unsaved feedback');
  expect(
    el('tracks')
      .querySelectorAll()
      .map((node) => node.disabled),
  ).toEqual(idleDisabled);
  expect(el('send').disabled).toBe(false);
  state.draft.entries.reverse();
  state.draft.revision++;
  runtime.busy = true;
  runInNewContext(`${renderSource}; render();`, runtime);
  const movingRows = [...el('tracks').children];

  runtime.busy = false;
  runInNewContext(`${renderSource}; render();`, runtime);
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
  expect(runtime.edit).toHaveBeenLastCalledWith({ selected_entry_ids: [] });
  el('timeline').children[1].onclick();
  expect(runtime.edit).toHaveBeenLastCalledWith({ selected_entry_ids: ['b', 'a'] });
  state.draft.save = { status: 'pending' };
  runInNewContext(`${renderSource}; render();`, runtime);
  expect(el('timeline').children.every((node) => node.disabled)).toBe(true);
  state.draft.save = undefined;
  runInNewContext(`${renderSource}; render();`, runtime);
  expect(el('timeline').children.every((node) => !node.disabled)).toBe(true);
});
