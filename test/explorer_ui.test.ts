import { afterEach, expect, it, vi } from 'vitest';
import {
  unpackRefresh,
  unpackExplorer,
  toggleSeed,
  curationMessage,
  explorerContext,
  decadeFilters,
} from '../ui/explorer-state.js';
import { connectExplorer } from '../ui/explorer-controller.js';
import { handleLibraryExplorer } from '../src/tools/library_explorer.js';
import { makeToolDeps } from './helpers.js';
import { elementLookup, Element } from './dom.js';

const closers: (() => void)[] = [];

afterEach(() => {
  closers.splice(0).forEach((close) => close());
});

async function setup() {
  const deps = makeToolDeps();

  closers.push(() => deps.cacheInstance.close());
  const data = await handleLibraryExplorer({ limit: 2 }, deps);
  const result = { structuredContent: data };
  const el = elementLookup();
  const app = {
    ontoolresult: vi.fn(),
    ontoolinput: vi.fn(),
    onhostcontextchanged: vi.fn(),
    connect: vi.fn(async () => {
      app.ontoolresult(result);
    }),
    getHostContext: () => ({ theme: 'dark' }),
    sendSizeChanged: vi.fn(async () => {}),
    updateModelContext: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    callServerTool: vi.fn(async ({ name, arguments: args }) => {
      if (name !== 'show_library_explorer') throw new Error(`Unexpected tool: ${name}`);

      return { structuredContent: await handleLibraryExplorer(args, deps) };
    }),
  };

  await connectExplorer(app, {
    el,
    host: new Element(),
    observeSize: vi.fn(),
    applyHostStyleVariables: vi.fn(),
  });

  return { deps, el, app, state: unpackExplorer(result) };
}

async function settled(el: ReturnType<typeof elementLookup>) {
  await vi.waitFor(() => expect(el('browse').inert).toBe(false));
}

it('keeps exact IDs for separate copies and limits selection without silently dropping seeds', async () => {
  const { state } = await setup();
  let selected = new Map();

  for (let i = 0; i < 50; i++)
    selected = toggleSeed(selected, { ...state.tracks[0], persistent_id: `id-${i}` });

  expect(() => toggleSeed(selected, { persistent_id: '51' })).toThrow('50');
  expect(selected.size).toBe(50);
  selected = toggleSeed(selected, { persistent_id: 'id-1' });
  expect(selected.has('id-1')).toBe(false);
  expect(explorerContext(state, selected).selected_track_ids).toEqual([...selected.keys()]);
  expect(curationMessage(state, selected, 'Make it slow')).toContain('Make it slow');
  expect(curationMessage(state, new Map(), 'Explore')).toContain('filtered_slice');
  expect(() => curationMessage(state, selected, '   ')).toThrow('Describe');
});

it('validates host payloads and uses plain JSON when structured content is absent', async () => {
  const { state } = await setup();

  expect(unpackExplorer({ content: [{ type: 'text', text: JSON.stringify(state) }] })).toEqual(
    state,
  );
  expect(() =>
    unpackExplorer({ structuredContent: { ...state, tracks: [{ persistent_id: 42 }] } }),
  ).toThrow('Invalid library response');
  expect(() =>
    unpackExplorer({ content: [{ type: 'text', text: 'cache failure' }], isError: true }),
  ).toThrow('cache failure');
  expect(() =>
    unpackExplorer({ structuredContent: { error: 'cache_unavailable', hint: 'Reconnect' } }),
  ).toThrow('Reconnect');
});

it('maps decade toggles to the shared inclusive year filters', () => {
  expect(decadeFilters({ loved: true }, '1990s')).toEqual({
    loved: true,
    year_min: 1990,
    year_max: 1999,
  });
  expect(decadeFilters({ loved: true, year_min: 1990, year_max: 1999 }, '1990s')).toEqual({
    loved: true,
  });
});

it('preserves checkbox nodes on selection and carries seeds across pages into the explicit message', async () => {
  const { el, app, state } = await setup();
  const check = el('tracks').querySelectorAll('input')[0];

  check.onchange();
  expect(check.checked).toBe(true);
  expect(el('tracks').querySelectorAll('input')[0]).toBe(check);
  expect(app.callServerTool).not.toHaveBeenCalled();
  expect(app.sendMessage).not.toHaveBeenCalled();
  el('next').onclick();
  await settled(el);
  expect(el('selection-label').textContent).toBe('1 seed track selected');
  el('request').value = 'Make a slow opening';
  await el('ask').onclick();
  expect(app.sendMessage.mock.calls[0][0].content[0].text).toContain(state.tracks[0].persistent_id);
  expect(app.sendMessage.mock.calls[0][0].content[0].text).toContain('Make a slow opening');
  expect(el('status').textContent).toContain('composer');
});

it('clears selection on a successful filter change and ignores a replayed original result', async () => {
  const { el, app, state } = await setup();

  el('tracks').querySelectorAll('input')[0].onchange();
  el('loved').onclick();
  await settled(el);
  expect(el('selection').children).toHaveLength(0);
  expect(el('loved').attributes['aria-pressed']).toBe('true');
  app.ontoolresult({ structuredContent: state });
  expect(el('loved').attributes['aria-pressed']).toBe('true');
  const lastContext = app.updateModelContext.mock.calls.at(-1)[0].content[0].text;

  expect(lastContext).toContain('"loved":true');
  expect(lastContext).toContain('"selected_track_ids":[]');
});

it('retains the previous slice and selection on failure, restores filter inputs and allows an explicit retry', async () => {
  const { el, app } = await setup();

  el('tracks').querySelectorAll('input')[0].onchange();
  app.callServerTool.mockRejectedValueOnce(new Error('Cache offline'));
  el('query').value = 'new query';
  el('search-form').onsubmit({ preventDefault() {} });
  await settled(el);
  expect(el('query').value).toBe('');
  expect(el('selection-label').textContent).toBe('1 seed track selected');
  expect(el('status').textContent).toBe('Cache offline');
  expect(app.callServerTool).toHaveBeenCalledTimes(1);
  await el('reload').onclick();
  expect(app.callServerTool).toHaveBeenCalledTimes(2);
  expect(el('selection').children).toHaveLength(0);
});

it('makes no initial tool calls, refreshes only on the explicit action and does not retry a failure', async () => {
  const { el, app } = await setup();

  expect(app.callServerTool).not.toHaveBeenCalled();
  app.callServerTool.mockResolvedValueOnce({
    structuredContent: { error: 'music_app_not_running', hint: 'Open Music' },
  });
  await el('refresh').onclick();
  expect(app.callServerTool).toHaveBeenCalledExactlyOnceWith({
    name: 'refresh_library',
    arguments: {},
  });
  expect(el('status').textContent).toBe('Open Music');
});

it('orders asynchronous context updates so an old selection cannot overwrite a new one', async () => {
  const { el, app } = await setup();
  let finish!: () => void;

  app.updateModelContext.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const [one, two] = el('tracks').querySelectorAll('input');

  one.onchange();
  await vi.waitFor(() => expect(app.updateModelContext).toHaveBeenCalledTimes(1));
  two.onchange();
  expect(app.updateModelContext).toHaveBeenCalledTimes(1);
  finish();
  await vi.waitFor(() => expect(app.updateModelContext).toHaveBeenCalledTimes(2));
  const final = app.updateModelContext.mock.calls[1][0].content[0].text;

  expect(final).toContain(one.dataset.trackId);
  expect(final).toContain(two.dataset.trackId);
});

it('rejects malformed refresh receipts and reloads only after a validated success', async () => {
  expect(() => unpackRefresh({ structuredContent: { success: true } })).toThrow(
    'Invalid refresh response',
  );
  const { el, app } = await setup();

  app.callServerTool.mockResolvedValueOnce({
    structuredContent: { track_count: 6, playlist_count: 2, refreshed_at: '2026-09-09T00:00:00Z' },
  });
  await el('refresh').onclick();
  expect(app.callServerTool.mock.calls.map(([call]) => call.name)).toEqual([
    'refresh_library',
    'show_library_explorer',
  ]);
  expect(app.callServerTool.mock.calls[1][0].arguments.offset).toBe(0);
});

it('invalidates old rows and seed context when refresh succeeds but the next read fails', async () => {
  const { el, app } = await setup();

  el('loved').onclick();
  await settled(el);
  el('tracks').querySelectorAll('input')[0].onchange();
  app.callServerTool.mockResolvedValueOnce({
    structuredContent: { track_count: 6, playlist_count: 2, refreshed_at: '2026-09-09T00:00:00Z' },
  });
  app.callServerTool.mockRejectedValueOnce(new Error('Cache unavailable'));
  await el('refresh').onclick();
  expect(el('browse').inert).toBe(true);
  expect(el('ask').disabled).toBe(true);
  expect(el('selection').children).toHaveLength(0);
  expect(el('status').textContent).toContain('Library refreshed, but the view could not reload');
  await vi.waitFor(() =>
    expect(app.updateModelContext.mock.calls.at(-1)[0].content[0].text).toContain('unavailable'),
  );
  await el('reload').onclick();
  expect(el('browse').inert).toBe(false);
  expect(app.callServerTool.mock.calls.at(-1)[0].arguments.filters).toEqual({ loved: true });
});
