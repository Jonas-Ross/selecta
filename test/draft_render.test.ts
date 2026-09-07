// Controlled DOM: verify node lifetime across the async edit lifecycle without
// a browser or Music.app. Replacing moving nodes cancels their animations.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  scrollTop = 0;
  disabled = false;
  inert = false;
  textContent = '';
  value = '';
  constructor(readonly tag = 'div') {}
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
  setAttribute() {}
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
  const renderSource = source.slice(
    source.indexOf('function render()'),
    source.indexOf('\nasync function action('),
  );
  const state = {
    draft: {
      draft_id: 'draft',
      revision: 1,
      name: 'Fixture',
      feedback: '',
      selected_entry_ids: [],
      entries: [
        { entry_id: 'a', track_id: 'same', pinned: false },
        { entry_id: 'b', track_id: 'same', pinned: false },
      ],
    },
  };
  const runtime = {
    state,
    busy: false,
    el,
    document: { createElement: (tag: string) => new Element(tag) },
    duration: String,
    edit: () => {},
    renderedTracks: undefined as string | undefined,
  };

  runInNewContext(`${renderSource}; render();`, runtime);
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
  const controls = el('tracks').querySelectorAll();

  expect(controls.filter((node) => node.tag === 'input').every((node) => !node.disabled)).toBe(
    true,
  );
  expect(controls.filter((node) => node.tag === 'button' && node.disabled)).toHaveLength(2);
});
