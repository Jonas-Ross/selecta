import { App, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'Selecta playlist draft', version: '1.0.0' }, {});
const el = (id) => document.getElementById(id);
let state;
let draftId;
let busy = false;
let connected = false;
const status = (text) => {
  el('status').textContent = text;
};
const duration = (seconds) => {
  if (seconds == null) return 'duration unknown';

  const total = Math.round(seconds);

  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

function theme(context) {
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);

  if (context?.theme) document.documentElement.style.colorScheme = context.theme;
}

function unpack(result) {
  const data =
    result.structuredContent ??
    JSON.parse(result.content?.find((item) => item.type === 'text')?.text ?? '{}');

  if (result.isError || data.error)
    throw new Error(data.hint ?? 'Tool failed. Reload the latest draft before continuing.');

  if (!data.draft)
    throw new Error('Original draft data is unavailable. Recover using the draft ID.');

  return data;
}

function accept(data) {
  if (
    state &&
    data.draft.draft_id === state.draft.draft_id &&
    data.draft.revision < state.draft.revision
  )
    return;

  state = data;
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
          text: `Selecta draft context (pins are user intent): ${JSON.stringify(context())}`,
        },
      ],
    });
  } catch {
    status(
      'Draft saved locally. Context delivery failed; use Send feedback or ask the agent to get this draft.',
    );
  }
}

function render() {
  if (!state) return;

  const { draft, inspection, inspection_error } = state;

  el('name').textContent = draft.name;
  el('identity').textContent = `Draft ${draft.draft_id} · revision ${draft.revision}`;
  el('recover-id').value = draft.draft_id;
  el('recovery').hidden = true;
  el('editor').hidden = false;
  el('reload').disabled = busy;
  el('feedback').value = draft.feedback;
  el('feedback').disabled = busy || draft.save?.status === 'pending';
  el('send').disabled = busy;
  el('keep-feedback').disabled = busy || draft.save?.status === 'pending';
  el('save').disabled = busy || !!draft.save || !!inspection_error;
  el('summary').textContent = inspection
    ? `${inspection.track_count} entries · ${duration(inspection.runtime.known_seconds)} known runtime${inspection.runtime.missing_count ? ` · ${inspection.runtime.missing_count} missing durations` : ''} · ${inspection.duplicate_ids.length} repeated track IDs`
    : (inspection_error?.hint ?? 'Inspection unavailable');
  el('details').textContent = inspection
    ? `${inspection.artist_counts.map((item) => `${item.artist} ×${item.count}`).join(' · ')}. Unknown artists: ${inspection.unknown_artist_count}. Missing BPM: ${inspection.feature_coverage.bpm.missing_count}; key: ${inspection.feature_coverage.musical_key.missing_count}. Owned-copy duplicates: ${inspection.duplicate_owned_copies.length}.`
    : 'Restore or replace missing tracks with the agent before saving.';
  el('tracks').replaceChildren();
  draft.entries.forEach((entry, index) => {
    const track = inspection?.tracks[index];
    const row = document.createElement('li');
    const select = document.createElement('input');

    select.type = 'checkbox';
    select.checked = draft.selected_entry_ids.includes(entry.entry_id);
    select.setAttribute(
      'aria-label',
      `Select entry ${index + 1}: ${track?.title ?? entry.track_id}`,
    );
    select.disabled = busy || draft.save?.status === 'pending';
    select.onchange = () =>
      edit({
        selected_entry_ids: select.checked
          ? [...draft.selected_entry_ids, entry.entry_id]
          : draft.selected_entry_ids.filter((id) => id !== entry.entry_id),
      });
    const position = document.createElement('span');

    position.textContent = String(index + 1);
    const text = document.createElement('div');
    const title = document.createElement('div');

    title.className = 'title';
    title.textContent = track?.title ?? 'Title unavailable';
    const facts = document.createElement('div');

    facts.className = 'facts';
    const repeated = draft.entries.filter((item) => item.track_id === entry.track_id).length;

    facts.textContent = `${track?.artist ?? 'Artist unknown'} · ${duration(track?.duration_seconds)} · ${track?.bpm == null ? 'BPM unknown' : `${track.bpm} BPM`} · ${track?.musical_key ?? 'Key unknown'}${repeated > 1 ? ` · repeated ×${repeated}` : ''}`;
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
      button.setAttribute('aria-label', `Move entry ${index + 1} ${delta < 0 ? 'up' : 'down'}`);
      button.disabled =
        busy ||
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

    const pin = document.createElement('button');

    pin.textContent = entry.pinned ? 'Pinned' : 'Pin';
    pin.setAttribute('aria-label', `Pin entry ${index + 1}`);
    pin.setAttribute('aria-pressed', String(entry.pinned));
    pin.disabled = busy || draft.save?.status === 'pending';
    pin.onclick = () =>
      edit({
        entries: draft.entries.map((item) =>
          item.entry_id === entry.entry_id ? { ...item, pinned: !item.pinned } : item,
        ),
      });
    actions.append(pin);
    row.append(select, position, text, actions);
    el('tracks').append(row);
  });
}

async function action(fn) {
  if (busy) return;

  busy = true;
  render();

  try {
    await fn();
  } catch (error) {
    status(`${error.message} No automatic retry. Use Reload latest to inspect current state.`);
  } finally {
    busy = false;
    render();
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
    status(`Draft revision ${state.draft.revision} saved locally.`);
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
    status(
      data.draft.save
        ? `Save attempt: ${data.draft.save.status}. ${JSON.stringify(data.draft.save.result ?? 'Outcome unknown; inspect Music.app before any further write.')}`
        : 'Latest local draft restored.',
    );
  });
}

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
          text: `Please revise this Selecta draft using my feedback and pinned-entry instructions: ${JSON.stringify(context())}`,
        },
      ],
    });
    status('Feedback handed to the host. If it appears in the composer, press Send.');
  });
};

el('save').onclick = () =>
  action(async () => {
    const revision = state.draft.revision;

    status(`Saving revision ${revision} to Music.app…`);
    const result = await app.callServerTool({
      name: 'save_playlist_draft',
      arguments: { draft_id: draftId, revision },
    });
    // Errors may include a persisted receipt/partial write. Keep it visible.
    const data =
      result.structuredContent ??
      JSON.parse(result.content.find((item) => item.type === 'text').text);

    if (data.draft) accept({ ...state, draft: data.draft });

    if (result.isError || data.error)
      throw new Error(data.hint ?? 'Save failed. Inspect the stored outcome.');

    status(`Saved revision ${revision}. ${JSON.stringify(data.result)}`);
    await publish();
  });

app.ontoolinput = ({ arguments: args }) => {
  if (typeof args?.draft_id === 'string') {
    draftId = args.draft_id;
    el('recover-id').value = draftId;

    if (connected) void recover(draftId);
  }
};

app.ontoolresult = (result) => {
  try {
    accept(unpack(result));

    if (connected) void recover(draftId);
  } catch (error) {
    status(error.message);

    if (draftId && connected) void recover(draftId);
  }
};

app.onhostcontextchanged = theme;

try {
  await app.connect();
  connected = true;
  theme(app.getHostContext());
  status('Ready. Recover a draft by ID if its original result is unavailable.');

  if (draftId) await recover(draftId);
} catch (error) {
  status(`Host connection failed: ${error.message}. Reopen this card after reconnecting Selecta.`);
}
