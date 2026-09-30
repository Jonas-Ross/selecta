import { decadeFilters } from './explorer-state.js';

const number = (n) => n.toLocaleString();

function node(document, tag, text, className) {
  const el = document.createElement(tag);

  if (text !== undefined) el.textContent = text;

  if (className) el.className = className;

  return el;
}

export function renderExplorer(el, state, actions) {
  const document = el('tracks').ownerDocument;
  const { overview, filters } = state;

  el('summary').textContent =
    `${number(state.total_matches)} tracks · ${overview.total_runtime_human} of known runtime`;
  const age = overview.cache_age_hours;

  el('age').textContent =
    age === null
      ? 'Cache has never been populated. Refresh to load your library.'
      : `Cached ${age < 1 ? 'less than an hour' : `${number(Math.round(age))} hours`} ago`;
  el('query').value = filters.query ?? '';
  el('genre').value = filters.genre ?? '';
  el('year-min').value = filters.year_min ?? '';
  el('year-max').value = filters.year_max ?? '';
  el('sort').value = state.sort;
  el('never').setAttribute('aria-pressed', String(filters.max_plays === 0));
  el('loved').setAttribute('aria-pressed', String(filters.loved === true));
  el('recent').setAttribute('aria-pressed', String(actions.recentCutoff === filters.added_after));
  el('active').replaceChildren();

  for (const [key, value] of Object.entries(filters)) {
    const chip = node(
      document,
      'button',
      `${key.replaceAll('_', ' ')}: ${Array.isArray(value) ? value.join(', ') : value} ×`,
    );

    chip.setAttribute('aria-label', `Remove ${key} filter`);

    chip.onclick = () => {
      const next = { ...filters };

      delete next[key];
      actions.filter(next);
    };

    el('active').append(chip);
  }

  el('decades').replaceChildren();
  const maxDecade = Math.max(1, ...overview.decades.map((d) => d.count));

  for (const { decade, count } of overview.decades) {
    const button = node(document, 'button', undefined, 'decade');

    button.style.cssText = `--fraction:${count / maxDecade}`;
    button.setAttribute('aria-label', `${decade}: ${number(count)} tracks`);
    const year = Number.parseInt(decade, 10);

    button.setAttribute(
      'aria-pressed',
      String(filters.year_min === year && filters.year_max === year + 9),
    );
    button.append(
      node(document, 'span', number(count)),
      node(document, 'span', undefined, 'bar'),
      node(document, 'span', decade),
    );
    button.onclick = () => actions.filter(decadeFilters(filters, decade));
    el('decades').append(button);
  }

  if (!overview.decades.length)
    el('decades').append(node(document, 'p', 'No known release years.', 'note'));

  el('year-note').textContent =
    `${number(state.missing.year)} without a year.${state.decades_other.distinct ? ` ${state.decades_other.distinct} more decades (${number(state.decades_other.tracks)} tracks); use year fields below.` : ''}`;
  el('genres').replaceChildren();
  const maxGenre = Math.max(1, ...overview.genres.map((g) => g.count));

  for (const { name, count } of overview.genres) {
    const button = node(document, 'button', undefined, 'genre');

    button.style.cssText = `--fraction:${count / maxGenre}`;
    button.setAttribute('aria-label', `${name}: ${number(count)} tracks`);
    button.title = name;
    button.setAttribute('aria-pressed', String(filters.genre === name));
    button.append(node(document, 'span', name), node(document, 'span', number(count)));

    button.onclick = () => {
      const next = { ...filters };

      if (next.genre === name) delete next.genre;
      else next.genre = name;

      actions.filter(next);
    };

    el('genres').append(button);
  }

  if (!overview.genres.length) el('genres').append(node(document, 'p', 'No genre tags.', 'note'));

  el('genre-note').textContent =
    `${number(state.missing.genre)} without a genre.${overview.genres_other ? ` ${overview.genres_other.distinct} more raw genres (${number(overview.genres_other.tracks)} tracks); enter a genre below.` : ''}`;
  el('tracks').replaceChildren();

  for (const track of state.tracks) {
    const row = node(document, 'label', undefined, 'track');
    const check = node(document, 'input');

    check.type = 'checkbox';
    check.dataset.trackId = track.persistent_id;
    check.setAttribute(
      'aria-label',
      `Select ${track.title ?? 'Unknown title'} by ${track.artist ?? 'Unknown artist'} (${track.persistent_id})`,
    );
    check.onchange = () => actions.select(track);
    const identity = node(document, 'div');
    const title = `${track.title ?? 'Unknown title'}${track.signal.loved ? ' ♥' : ''}`;

    identity.append(
      node(document, 'div', title, 'track-title'),
      node(
        document,
        'div',
        `${track.artist ?? 'Unknown artist'} · ${track.album ?? 'Unknown album'}`,
        'track-detail',
      ),
    );
    identity.title = `${title}\n${track.artist ?? 'Unknown artist'}\n${track.album ?? 'Unknown album'}\n${track.genre ?? 'Unknown genre'}\n${track.persistent_id}`;
    const facts = node(document, 'div', undefined, 'track-numbers');

    facts.append(
      node(document, 'div', track.year > 0 ? String(track.year) : 'Year unknown'),
      node(document, 'div', `${number(track.signal.play_count)} plays`),
    );
    row.append(check, identity, facts);
    el('tracks').append(row);
  }

  el('tracks').scrollTop = 0;

  if (!state.tracks.length)
    el('tracks').append(
      node(
        document,
        'p',
        state.total_matches
          ? 'This page is no longer available. Return to the previous page or reload the view.'
          : Object.keys(filters).length > 0
            ? 'No tracks match. Remove a filter or broaden your search.'
            : 'No tracks in the cached library. Use Refresh library to check Music.app.',
        'empty',
      ),
    );

  el('page-label').textContent = state.tracks.length
    ? `${number(state.offset + 1)}–${number(state.offset + state.tracks.length)} of ${number(state.total_matches)}`
    : `0 shown of ${number(state.total_matches)}`;
  el('previous').disabled = state.offset === 0;
  el('next').disabled = state.next_offset === null;
  el('activity').textContent =
    `${number(overview.recent_activity.total_plays)} plays and ${number(overview.recent_activity.total_skips)} skips captured between manual refreshes in the last ${overview.recent_activity.window_days} days. This is not continuous listening history; zero may mean no refresh captured listening.`;
}

export function renderSelection(el, state, selected, onRemove) {
  const document = el('selection').ownerDocument;

  for (const checkbox of el('tracks').querySelectorAll('input'))
    checkbox.checked = selected.has(checkbox.dataset.trackId);

  el('selection-label').textContent = selected.size
    ? `${selected.size} seed ${selected.size === 1 ? 'track' : 'tracks'} selected`
    : `Use this slice of ${number(state.total_matches)} tracks`;
  el('clear-selection').hidden = selected.size === 0;
  el('selection').replaceChildren();

  for (const track of selected.values()) {
    const button = node(document, 'button', `${track.title ?? 'Unknown title'} ×`);

    button.setAttribute(
      'aria-label',
      `Remove seed ${track.title ?? track.persistent_id} (${track.persistent_id})`,
    );
    button.onclick = () => onRemove(track);
    el('selection').append(button);
  }
}
