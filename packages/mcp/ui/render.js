import { timelineEntries, renderTimeline, clockLabel } from './timeline.js';
import { reconcileChildren, element } from './reconcile.js';

// The card view: paint every element from draft state. Host and tool calls
// stay in playlist-draft.js, so this runs against a controlled DOM in tests.
export function renderDraft(el, { draft, inspection, inspection_error, busy, lanes = {}, edit }) {
  const pending = draft.save?.status === 'pending';
  const selectedIds = new Set(draft.selected_entry_ids);
  const toggleSelection = (id) =>
    edit({
      selected_entry_ids: selectedIds.has(id)
        ? draft.selected_entry_ids.filter((entryId) => entryId !== id)
        : [...draft.selected_entry_ids, id],
    });

  el('editor').inert = busy;
  el('editor').setAttribute('aria-busy', String(busy));
  el('name').textContent = draft.name;
  el('identity').textContent = `Draft ${draft.draft_id}`;
  el('revision').textContent = `Revision ${draft.revision}`;
  // The toggle counts; the composer heading names, so the two never repeat
  // each other and the subject of feedback is spelled out where it is typed.
  const selected = draft.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => selectedIds.has(entry.entry_id));
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
  el('feedback').disabled = pending;
  el('send').disabled = false;
  el('keep-feedback').disabled = pending;
  el('save').disabled = !!draft.save || !!inspection_error;
  el('summary').textContent = inspection
    ? `${inspection.track_count} tracks / ${clockLabel(inspection.runtime.known_seconds)}${inspection.runtime.missing_count ? ' known runtime' : ' runtime'}${inspection.duplicate_ids.length ? ` / ${inspection.duplicate_ids.length} repeated` : ''}`
    : (inspection_error?.hint ?? 'Inspection unavailable');
  el('details').textContent = inspection
    ? `${inspection.artist_counts.map((item) => `${item.artist} ×${item.count}`).join(' · ')}. Unknown artists: ${inspection.unknown_artist_count}. Missing durations: ${inspection.runtime.missing_count}. Missing BPM: ${inspection.feature_coverage.bpm.missing_count}. Owned-copy duplicates: ${inspection.duplicate_owned_copies.length}.`
    : 'Restore or replace missing tracks with the agent before saving.';
  const runtime = inspection?.runtime;

  el('timeline-note').textContent = !runtime
    ? 'Inspection unavailable.'
    : runtime.missing_count
      ? `${runtime.missing_count} ${runtime.missing_count === 1 ? 'duration' : 'durations'} unknown.`
      : `Ends at ${clockLabel(runtime.known_seconds)}.`;

  // Lanes are view state: the spans are always rendered, CSS shows them.
  for (const lane of ['tempo', 'key'])
    el('timeline').classList.toggle(`show-${lane}`, !!lanes[lane]);

  const entries = timelineEntries(draft.entries, inspection?.tracks);

  renderTimeline(el('timeline'), entries, {
    selected: draft.selected_entry_ids,
    disabled: pending,
    onSelect: toggleSelection,
  });
  renderTracks(el, { draft, entries, pending, selectedIds, edit, toggleSelection });
}

function renderTracks(el, { draft, entries, pending, selectedIds, edit, toggleSelection }) {
  const document = el('tracks').ownerDocument;
  const node = (tag, className) => element(document, tag, className);
  const repeats = new Map();

  for (const entry of draft.entries)
    repeats.set(entry.track_id, (repeats.get(entry.track_id) ?? 0) + 1);

  // A column of dashes says only "no data"; blank cells let real values stand out.
  el('queue-head').classList.toggle('no-bpm', !entries.some((entry) => entry.bpm !== null));
  reconcileChildren(el('tracks'), entries, {
    // The skeleton is fixed; update() only assigns. Optional spans stay in
    // place and hide when empty.
    create: () => {
      const row = node('li', 'track-row');
      const select = node('input', '');
      const title = node('div', 'title');
      const badge = node('span', 'repeat');
      const facts = node('div', 'artist');
      const text = node('div', 'track-name');
      const actions = node('div', 'actions');
      const up = node('button', 'move');
      const down = node('button', 'move');

      select.type = 'checkbox';
      badge.title = 'Repeated track';
      title.append(node('span', ''), badge);
      facts.append(node('span', ''), node('span', 'mobile-bpm'));
      text.append(title, facts);
      up.textContent = '↑';
      down.textContent = '↓';
      actions.append(up, down);
      row.append(
        select,
        node('span', 'number'),
        text,
        node('span', 'metric'),
        node('span', 'metric bpm'),
        actions,
      );

      return row;
    },
    update: (row, entry, index) => {
      const [select, position, text, time, bpm, actions] = row.children;
      const [title, facts] = text.children;
      const count = repeats.get(entry.track_id);
      const duration = entry.seconds === null ? '—' : clockLabel(entry.seconds);

      row.classList.toggle('selected', selectedIds.has(entry.entry_id));
      select.checked = selectedIds.has(entry.entry_id);
      select.setAttribute('aria-label', `Select entry ${entry.position}: ${entry.title}`);
      select.disabled = pending;
      select.onchange = () => toggleSelection(entry.entry_id);
      position.textContent = String(entry.position).padStart(2, '0');
      title.children[0].textContent = entry.title;
      title.children[1].textContent = count > 1 ? `×${count}` : '';
      facts.children[0].textContent = entry.artist;
      facts.children[1].textContent = entry.bpm === null ? '' : ` / ${entry.bpm} BPM`;
      text.title = `Entry ${entry.entry_id}\nTrack ${entry.track_id}`;
      time.textContent = duration;
      time.title = entry.seconds === null ? 'Duration unknown' : `Duration: ${duration}`;
      bpm.textContent = entry.bpm ?? '';
      bpm.title = entry.bpm === null ? 'BPM unknown' : 'BPM';

      for (const [which, button] of [...actions.children].entries()) {
        const delta = which ? 1 : -1;
        const edge = index + delta < 0 || index + delta >= draft.entries.length;

        button.setAttribute('aria-label', `Move entry ${entry.position} ${which ? 'down' : 'up'}`);
        button.disabled = pending || edge;

        button.onclick = () => {
          const order = [...draft.entries];

          [order[index], order[index + delta]] = [order[index + delta], order[index]];
          void edit({ entries: order });
        };
      }
    },
  });
}
