import { recentSinceIso } from '../src/domain/recent_activity.ts';
import {
  unpackRefresh,
  unpackExplorer,
  toggleSeed,
  explorerContext,
  curationMessage,
} from './explorer-state.js';
import { renderExplorer, renderSelection } from './explorer-render.js';

export async function connectExplorer(app, { host, el, observeSize, applyHostStyleVariables }) {
  let state;
  let selected = new Map();
  let busy = false;
  let connected = false;
  let initialInput = {};
  let receivedResult = false;
  let interacted = false;
  let contextDelivery = Promise.resolve();
  const recentCutoff = recentSinceIso();
  const status = (message, error = false) => {
    el('status').textContent = message;
    el('status').dataset.error = String(error);
  };

  function theme(context) {
    if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);

    if (context?.theme) host.style.colorScheme = context.theme;
  }

  function controls() {
    el('browse').inert = busy || !connected || !state;
    el('refresh').disabled = busy || !connected;
    el('reload').disabled = busy || !connected;
    el('ask').disabled = busy || !connected || !state?.total_matches || !el('request').value.trim();
    el('clear-selection').disabled = busy;
    el('selection').inert = busy;
  }

  function publish() {
    if (!connected) return Promise.resolve();

    const context = state
      ? explorerContext(state, selected)
      : {
          selected_track_ids: [],
          selection_scope: 'unavailable',
          hint: 'The library was refreshed. Reload the view before curating; earlier selection and counts are no longer current.',
        };

    // Preserve delivery order even when a host acknowledges updates slowly.
    contextDelivery = contextDelivery.then(async () => {
      try {
        await app.updateModelContext({
          content: [
            {
              type: 'text',
              text: `Library explorer selection is context only, not a requested action: ${JSON.stringify(context)}`,
            },
          ],
        });
      } catch {
        status(
          'Context delivery failed. Ask agent includes your exact selection and filters.',
          true,
        );
      }
    });

    return contextDelivery;
  }

  function selection() {
    renderSelection(el, state, selected, select);
    controls();
  }

  function select(track) {
    if (busy) return;

    interacted = true;

    try {
      selected = toggleSeed(selected, track);
      status('Selection stays in this card until you ask the agent.');
    } catch (error) {
      status(error.message, true);
    }

    selection();
    void publish();
  }

  function accept(data, clear = false) {
    if (clear) selected = new Map();

    state = data;
    renderExplorer(el, state, {
      recentCutoff,
      select,
      filter: (filters) => load({ filters, offset: 0 }, true),
    });
    selection();
  }

  async function action(fn) {
    if (busy) return;

    interacted = true;
    busy = true;
    controls();

    try {
      await fn();
    } catch (error) {
      status(error.message, true);
    } finally {
      busy = false;
      controls();
    }
  }

  async function read(patch = {}, clear = false) {
    status('Loading library slice…');
    const args = {
      filters: state?.filters ?? initialInput.filters ?? {},
      sort: state?.sort ?? initialInput.sort,
      limit: state?.limit ?? initialInput.limit,
      offset: state?.offset ?? 0,
      ...patch,
    };
    let data;

    try {
      data = unpackExplorer(
        await app.callServerTool({ name: 'show_library_explorer', arguments: args }),
      );
    } catch (error) {
      // Restore the displayed inputs to the slice still shown after a failed query.
      if (state) accept(state);

      throw error;
    }

    accept(data, clear);
    status(
      clear
        ? 'View loaded. Selection cleared for this slice.'
        : 'View loaded. Selected seeds are kept across pages.',
    );
    await publish();
  }

  const load = (patch, clear = false) => action(() => read(patch, clear));

  el('search-form').onsubmit = (event) => {
    event.preventDefault();
    const filters = { ...state.filters };
    const query = el('query').value.trim();

    if (query) filters.query = query;
    else delete filters.query;

    void load({ filters, offset: 0 }, true);
  };

  el('facet-form').onsubmit = (event) => {
    event.preventDefault();
    const filters = { ...state.filters };
    const genre = el('genre').value;

    if (genre) filters.genre = genre;
    else delete filters.genre;

    for (const [id, key] of [
      ['year-min', 'year_min'],
      ['year-max', 'year_max'],
    ]) {
      if (el(id).value) filters[key] = Number(el(id).value);
      else delete filters[key];
    }

    void load({ filters, offset: 0 }, true);
  };

  for (const [id, key, value] of [
    ['never', 'max_plays', 0],
    ['loved', 'loved', true],
    ['recent', 'added_after', recentCutoff],
  ])
    el(id).onclick = () => {
      const filters = { ...state.filters };

      if (filters[key] === value) delete filters[key];
      else filters[key] = value;

      void load({ filters, offset: 0 }, true);
    };

  el('sort').onchange = () => load({ sort: el('sort').value, offset: 0 });
  el('previous').onclick = () => load({ offset: Math.max(0, state.offset - state.limit) });
  el('next').onclick = () => load({ offset: state.next_offset });
  el('reload').onclick = () => load({ offset: 0 }, true);

  el('clear-selection').onclick = () => {
    selected = new Map();
    selection();
    void publish();
  };

  el('request').oninput = controls;
  el('ask').onclick = () =>
    action(async () => {
      const result = await app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text: curationMessage(state, selected, el('request').value) }],
      });

      if (result.isError)
        throw new Error('Host rejected the request. Your request and selected seeds are kept.');

      status('Request handed to the host. If it appears in the composer, press Send.');
    });
  el('refresh').onclick = () =>
    action(async () => {
      status('Refreshing the cache from Music.app… This can take a minute.');
      const result = await app.callServerTool({ name: 'refresh_library', arguments: {} });

      unpackRefresh(result);

      // A refresh changed the cache even if the following read fails. Retire
      // the previous selection and disable stale rows until an explicit reload.
      if (state) {
        initialInput = { filters: state.filters, sort: state.sort, limit: state.limit };
        selected = new Map();
        selection();
      }

      state = undefined;
      el('selection-label').textContent = 'Reload the library view before curating';
      el('age').textContent = 'Library refreshed; view not yet loaded.';
      void publish();

      try {
        await read({ offset: 0 }, true);
      } catch (error) {
        throw new Error(
          `Library refreshed, but the view could not reload: ${error.message} Use Reload view.`,
        );
      }
    });

  app.ontoolinput = ({ arguments: args }) => {
    initialInput = args ?? {};
  };

  app.ontoolresult = (result) => {
    // Host replays must not replace a slice or selection the user has changed.
    if (interacted) return;

    receivedResult = true;

    try {
      accept(unpackExplorer(result));
      status('Choose a slice or select tracks, then describe what to make.');
    } catch (error) {
      status(error.message, true);
    }
  };

  app.onhostcontextchanged = theme;
  controls();

  try {
    await app.connect();
    connected = true;
    theme(app.getHostContext());
    observeSize(host, (height) => {
      void app.sendSizeChanged({ height }).catch(() => {});
    });
    controls();

    if (!receivedResult)
      status('Waiting for library data. Use Reload view if the original result is unavailable.');
  } catch (error) {
    status(
      `Host connection failed: ${error.message}. Reconnect Selecta and reopen the explorer.`,
      true,
    );
  }
}
