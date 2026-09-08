import { host, ui, el } from './dom.js';
import './pulse.js';
import { observeSize } from './resize.js';
import { timelineEntries, renderTimeline, clockLabel } from './timeline.js';
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
let renderedTracks;
let renderedTimeline;
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

function updateTimeline() {
  const { draft, inspection } = state;
  const key = JSON.stringify([draft, inspection?.tracks]);

  if (key === renderedTimeline) return;

  renderedTimeline = key;
  const entries = timelineEntries(draft.entries, inspection?.tracks);
  const missing = entries.filter((entry) => entry.seconds === null).length;
  const zero = entries.some((entry) => entry.seconds === 0);

  el('timeline-note').textContent = !inspection
    ? 'Inspection unavailable. Durations and features are unknown; reload after restoring missing tracks.'
    : missing
      ? `${missing} unknown ${missing === 1 ? 'duration' : 'durations'}. Hatched markers are not to scale; elapsed time after a gap is unknown.${zero ? ' Zero-duration markers are also not to scale.' : ''}`
      : `Ends at ${clockLabel(entries.at(-1)?.end ?? 0)}.${zero ? ' Zero-duration markers are not to scale.' : ''}`;
  const scrollLeft = el('timeline-scroll').scrollLeft;

  renderTimeline(el('timeline'), entries, {
    selected: draft.selected_entry_ids,
    disabled: draft.save?.status === 'pending',
    onSelect: toggleSelection,
  });
  el('timeline-scroll').scrollLeft = scrollLeft;
}

function toggleSelection(id) {
  const selected = state.draft.selected_entry_ids;

  return edit({
    selected_entry_ids: selected.includes(id)
      ? selected.filter((entryId) => entryId !== id)
      : [...selected, id],
  });
}

for (const lane of ['tempo', 'key']) {
  el(`timeline-${lane}`).onchange = () => {
    el('timeline').classList.toggle(`show-${lane}`, el(`timeline-${lane}`).checked);
  };
}

function render() {
  if (!state) return;

  const { draft, inspection, inspection_error } = state;

  el('editor').inert = busy;
  el('editor').setAttribute('aria-busy', String(busy));
  updateTimeline();

  el('name').textContent = draft.name;
  el('identity').textContent = `Draft ${draft.draft_id}`;
  el('revision').textContent = `Revision ${draft.revision}`;
  // The toggle counts; the composer heading names, so the two never repeat
  // each other and the subject of feedback is spelled out where it is typed.
  const selected = draft.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => draft.selected_entry_ids.includes(entry.entry_id));
  const positions = selected.map(({ index }) => String(index + 1).padStart(2, '0'));
  const feedbackScope = selected.length
    ? `Feedback on ${selected.length} ${selected.length === 1 ? 'track' : 'tracks'}`
    : 'Feedback on the playlist';
  const feedbackSubject =
    selected.length === 1
      ? `Feedback on ${positions[0]} · ${inspection?.tracks[selected[0].index]?.title ?? 'this track'}`
      : selected.length
        ? `Feedback on tracks ${positions.slice(0, 6).join(', ')}${positions.length > 6 ? ` +${positions.length - 6}` : ''}`
        : 'Feedback on the whole playlist';

  el('feedback-label').textContent = feedbackSubject;
  el('feedback-toggle').textContent = el('feedback-panel').hidden ? feedbackScope : 'Hide feedback';
  el('recover-id').value = draft.draft_id;
  el('recovery').hidden = true;
  el('editor').hidden = false;
  el('reload').disabled = false;
  el('reload').inert = busy;
  el('feedback').disabled = draft.save?.status === 'pending';
  el('send').disabled = false;
  el('keep-feedback').disabled = draft.save?.status === 'pending';
  el('save').disabled = !!draft.save || !!inspection_error;
  el('summary').textContent = inspection
    ? `${inspection.track_count} tracks / ${clockLabel(inspection.runtime.known_seconds)}${inspection.runtime.missing_count ? ' known runtime' : ' runtime'}${inspection.duplicate_ids.length ? ` / ${inspection.duplicate_ids.length} repeated` : ''}`
    : (inspection_error?.hint ?? 'Inspection unavailable');
  el('details').textContent = inspection
    ? `${inspection.artist_counts.map((item) => `${item.artist} ×${item.count}`).join(' · ')}. Unknown artists: ${inspection.unknown_artist_count}. Missing durations: ${inspection.runtime.missing_count}. Missing BPM: ${inspection.feature_coverage.bpm.missing_count}. Owned-copy duplicates: ${inspection.duplicate_owned_copies.length}.`
    : 'Restore or replace missing tracks with the agent before saving.';
  // Context delivery finishes independently of row motion. Changing only busy
  // state must not replace the DOM nodes that are currently animating.
  const trackView = JSON.stringify([
    draft.draft_id,
    draft.entries,
    draft.selected_entry_ids,
    inspection?.tracks,
  ]);

  if (trackView === renderedTracks) {
    for (const control of el('tracks').querySelectorAll('input, button')) {
      control.disabled =
        draft.save?.status === 'pending' || control.dataset.edgeDisabled === 'true';
    }

    return;
  }

  renderedTracks = trackView;
  const scrollTop = el('tracks').scrollTop;

  // A column of dashes says only "no data"; blank cells let real values stand out.
  el('queue-head').classList.toggle(
    'no-bpm',
    !inspection?.tracks.some((track) => track?.bpm != null),
  );
  el('tracks').replaceChildren();
  draft.entries.forEach((entry, index) => {
    const track = inspection?.tracks[index];
    const row = document.createElement('li');

    row.className = `track-row${draft.selected_entry_ids.includes(entry.entry_id) ? ' selected' : ''}`;
    const select = document.createElement('input');

    select.type = 'checkbox';
    select.dataset.focus = `select-${entry.entry_id}`;
    select.checked = draft.selected_entry_ids.includes(entry.entry_id);
    select.setAttribute(
      'aria-label',
      `Select entry ${index + 1}: ${track?.title ?? entry.track_id}`,
    );
    select.disabled = draft.save?.status === 'pending';
    select.onchange = () => toggleSelection(entry.entry_id);
    const position = document.createElement('span');

    position.textContent = String(index + 1).padStart(2, '0');
    position.className = 'number';
    const text = document.createElement('div');

    text.className = 'track-name';
    const title = document.createElement('div');

    title.className = 'title';
    title.textContent = track?.title ?? 'Title unavailable';
    const facts = document.createElement('div');

    facts.className = 'artist';
    const repeated = draft.entries.filter((item) => item.track_id === entry.track_id).length;

    facts.textContent = track?.artist ?? 'Artist unknown';

    if (repeated > 1) {
      const badge = document.createElement('span');

      badge.className = 'repeat';
      badge.textContent = `×${repeated}`;
      badge.title = 'Repeated track';
      title.append(badge);
    }

    const smallBpm = document.createElement('span');

    smallBpm.className = 'mobile-bpm';

    if (track?.bpm != null) {
      smallBpm.textContent = ` / ${track.bpm} BPM`;
      facts.append(smallBpm);
    }

    const time = document.createElement('span');

    time.className = 'metric';
    time.textContent = track?.duration_seconds == null ? '—' : clockLabel(track.duration_seconds);
    time.title =
      track?.duration_seconds == null ? 'Duration unknown' : `Duration: ${time.textContent}`;
    const bpm = document.createElement('span');

    bpm.className = 'metric bpm';
    bpm.textContent = track?.bpm ?? '';
    bpm.title = track?.bpm == null ? 'BPM unknown' : 'BPM';
    text.append(title, facts);
    text.title = `Entry ${entry.entry_id}\nTrack ${entry.track_id}`;
    const actions = document.createElement('div');

    actions.className = 'actions';

    for (const [label, delta] of [
      ['↑', -1],
      ['↓', 1],
    ]) {
      const button = document.createElement('button');

      button.textContent = label;
      button.className = 'move';
      button.dataset.focus = `move-${delta}-${entry.entry_id}`;
      button.setAttribute('aria-label', `Move entry ${index + 1} ${delta < 0 ? 'up' : 'down'}`);
      button.dataset.edgeDisabled = String(
        index + delta < 0 || index + delta >= draft.entries.length,
      );
      button.disabled =
        draft.save?.status === 'pending' ||
        index + delta < 0 ||
        index + delta >= draft.entries.length;

      button.onclick = () => {
        const entries = [...draft.entries];

        [entries[index], entries[index + delta]] = [entries[index + delta], entries[index]];
        void edit({ entries });
      };

      actions.append(button);
    }

    row.append(select, position, text, time, bpm, actions);
    el('tracks').append(row);
  });
  el('tracks').scrollTop = scrollTop;
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
