import { host, ui, el } from './dom.js';
import './pulse.js';
import { observeSize } from './resize.js';
import { renderDraft } from './render.js';
import { App, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

const app = new App(
  { name: 'Selecta playlist draft', version: '1.0.0' },
  {},
  { autoResize: false },
);
let state;
let draftId;
let busy = false;
let connected = false;
// tone: 'ok' | 'error' | 'pending' | undefined (neutral). The dot in front of
// the line is what makes a failed save look different from a restored draft.
const status = (text, tone) => {
  el('status').textContent = text;

  if (tone) el('status').dataset.tone = tone;
  else delete el('status').dataset.tone;
};

let hostTheme;
let appearance = 'host';

function theme(context) {
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);

  if (context?.theme) hostTheme = context.theme;

  host.style.colorScheme = appearance === 'oled' ? 'dark' : (hostTheme ?? 'light dark');
}

async function loadAppearance(value) {
  el('appearance').disabled = true;

  try {
    const result = await app.callServerTool({
      name: 'playlist_draft_appearance',
      arguments: value === undefined ? {} : { appearance: value },
    });
    const data = payload(result);

    if (
      result.isError ||
      !['host', 'copper', 'cobalt', 'ember', 'moss', 'oxblood', 'oled'].includes(data.appearance)
    )
      throw new Error(data.hint ?? 'Appearance unavailable.');

    appearance = data.appearance;
    host.dataset.palette = appearance;
    theme();
  } catch (error) {
    status(`Could not load or save appearance: ${error.message}`, 'error');
  } finally {
    el('appearance').value = appearance;
    el('appearance').disabled = false;
  }
}

el('appearance').onchange = () => loadAppearance(el('appearance').value);

// A handler that throws past its envelope reaches the card as plain text with
// no structured content; surface that text instead of a JSON parse failure.
function payload(result) {
  if (result.structuredContent) return result.structuredContent;

  const text = result.content?.find((item) => item.type === 'text')?.text ?? '';

  try {
    return JSON.parse(text);
  } catch {
    return { error: 'tool_failed', hint: text || 'Tool returned no readable response.' };
  }
}

function unpack(result) {
  const data = payload(result);

  if (result.isError || data.error)
    throw new Error(data.hint ?? 'Tool failed. Reload the latest draft before continuing.');

  if (!data.draft)
    throw new Error('Original draft data is unavailable. Recover using the draft ID.');

  return data;
}

function accept(data) {
  const previous = state?.draft;
  const sameDraft = previous?.draft_id === data.draft.draft_id;

  if (sameDraft && data.draft.revision < previous.revision) return;

  // Typed but unkept feedback survives a replayed result, a reload and a save
  // receipt; only another draft or a newer revision without local typing
  // replaces the field.
  const keepTyped =
    sameDraft &&
    (data.draft.revision === previous.revision || el('feedback').value !== previous.feedback);

  state = data;

  if (!keepTyped) el('feedback').value = data.draft.feedback;

  draftId = data.draft.draft_id;
  render();
}

function context() {
  return {
    draft_id: state.draft.draft_id,
    revision: state.draft.revision,
    entries: state.draft.entries,
    selected_entry_ids: state.draft.selected_entry_ids,
    feedback: state.draft.feedback,
  };
}

async function publish() {
  try {
    await app.updateModelContext({
      content: [
        {
          type: 'text',
          text: `Selecta draft context (selection identifies the subject of feedback, not a requested change): ${JSON.stringify(context())}`,
        },
      ],
    });
  } catch {
    status(
      'Draft saved locally. Context delivery failed; use Send feedback or ask the agent to get this draft.',
      'error',
    );
  }
}

const lanes = { tempo: false, key: false };

for (const lane of Object.keys(lanes))
  el(`timeline-${lane}`).onchange = () => {
    lanes[lane] = el(`timeline-${lane}`).checked;
    render();
  };

function render() {
  if (!state) return;

  renderDraft(el, { ...state, busy, lanes, edit });
}

async function action(fn) {
  if (busy) return;

  const focused = ui.activeElement;
  const focusKey = focused?.dataset.focus;

  busy = true;
  render();

  try {
    await fn();
  } catch (error) {
    status(
      `${error.message} No automatic retry. Use Reload latest to inspect current state.`,
      'error',
    );
  } finally {
    busy = false;
    render();

    if (focusKey)
      ui.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
    else focused?.focus({ preventScroll: true });
  }
}

async function edit(patch) {
  patch = { feedback: el('feedback').value, ...patch };
  await action(async () => {
    accept(
      unpack(
        await app.callServerTool({
          name: 'edit_playlist_draft',
          arguments: { draft_id: draftId, revision: state.draft.revision, ...patch },
        }),
      ),
    );
    status(`Draft revision ${state.draft.revision} saved locally.`, 'ok');
    await publish();
  });
}

async function recover(id) {
  if (!id || !connected) return;

  await action(async () => {
    const data = unpack(
      await app.callServerTool({ name: 'get_playlist_draft', arguments: { draft_id: id } }),
    );

    accept(data);

    if (data.draft.save)
      status(
        `Save attempt: ${data.draft.save.status}. ${JSON.stringify(data.draft.save.result ?? 'Outcome unknown; inspect Music.app before any further write.')}`,
        data.draft.save.status === 'ok' ? 'ok' : 'error',
      );
    else status('Latest local draft restored.', 'ok');
  });
}

el('feedback-toggle').onclick = () => {
  const panel = el('feedback-panel');

  panel.hidden = !panel.hidden;
  el('feedback-toggle').setAttribute('aria-expanded', String(!panel.hidden));
  render();

  if (!panel.hidden) el('feedback').focus();
};

el('options').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    el('options').open = false;
    el('options').querySelector('summary').focus();
  }
});
ui.addEventListener('click', (event) => {
  if (!event.composedPath().includes(el('options'))) el('options').open = false;
});

el('recover').onclick = () => recover(el('recover-id').value.trim());
el('reload').onclick = () => recover(draftId);
el('keep-feedback').onclick = () => edit({ feedback: el('feedback').value });

el('send').onclick = () => {
  const feedback = el('feedback').value;

  return action(async () => {
    if (feedback !== state.draft.feedback)
      accept(
        unpack(
          await app.callServerTool({
            name: 'edit_playlist_draft',
            arguments: { draft_id: draftId, revision: state.draft.revision, feedback },
          }),
        ),
      );

    await app.sendMessage({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Please revise this Selecta draft using my explicit feedback. Selected entry IDs identify the tracks I am referring to; an empty selection means the whole playlist. Selection alone does not request replacement, removal or preservation: ${JSON.stringify(context())}`,
        },
      ],
    });
    status('Feedback handed to the host. If it appears in the composer, press Send.', 'ok');
  });
};

el('save').onclick = () =>
  action(async () => {
    const revision = state.draft.revision;

    status(`Saving revision ${revision} to Music.app…`, 'pending');
    const result = await app.callServerTool({
      name: 'save_playlist_draft',
      arguments: { draft_id: draftId, revision },
    });
    // Errors may include a persisted receipt/partial write. Keep it visible.
    const data = payload(result);

    if (data.draft) accept({ ...state, draft: data.draft });

    if (result.isError || data.error)
      throw new Error(data.hint ?? 'Save failed. Inspect the stored outcome.');

    status(`Saved revision ${revision}. ${JSON.stringify(data.result)}`, 'ok');
    await publish();
  });

// Hosts may deliver tool input while show_playlist_draft is still running,
// before the draft row exists. Recovery from the input alone only serves a
// host that never delivers the result, so give the result a moment first.
const RESULT_GRACE_MS = 1500;
let resultFallback;

app.ontoolinput = ({ arguments: args }) => {
  if (typeof args?.draft_id !== 'string') return;

  draftId = args.draft_id;
  el('recover-id').value = draftId;
  clearTimeout(resultFallback);
  resultFallback = setTimeout(() => {
    if (!state && connected) void recover(draftId);
  }, RESULT_GRACE_MS);
};

app.ontoolresult = (result) => {
  clearTimeout(resultFallback);

  try {
    accept(unpack(result));

    // A replayed result after reload can be stale; the store holds the latest.
    if (connected) void recover(draftId);
  } catch (error) {
    status(error.message, 'error');

    // A failed show created nothing to recover; a stripped result did.
    if (draftId && connected && !result.isError) void recover(draftId);
  }
};

app.onhostcontextchanged = theme;

try {
  await app.connect();
  connected = true;
  observeSize(host, (height) => {
    void app
      .sendSizeChanged({ height })
      .catch((error) => console.error('Card sizing failed', error));
  });
  theme(app.getHostContext());
  status('Ready. Recover a draft by ID if its original result is unavailable.');

  if (draftId && !state) await recover(draftId);

  await loadAppearance();
} catch (error) {
  status(
    `Host connection failed: ${error.message}. Reopen this card after reconnecting Selecta.`,
    'error',
  );
}
