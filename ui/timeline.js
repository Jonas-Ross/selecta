// Occurrences stay in draft order. Unknown spans consume no invented time;
// the elapsed clock remains unknown after the first missing duration.
export function timelineEntries(entries, tracks = []) {
  let elapsed = 0;

  return entries.map((entry, index) => {
    const track = tracks[index];
    const seconds = track?.duration_seconds ?? null;
    const start = elapsed;

    elapsed = elapsed === null || seconds === null ? null : elapsed + seconds;

    return {
      ...entry,
      position: index + 1,
      title: track?.title ?? 'Title unavailable',
      artist: track?.artist?.trim() || 'Artist unknown',
      seconds,
      start,
      end: elapsed,
      bpm: track?.bpm ?? null,
      key: track?.musical_key ?? null,
    };
  });
}

export function clockLabel(seconds) {
  if (seconds === null) return 'Unknown';

  // Preserve subsecond facts rather than accumulating rounded track times.
  const rounded = Math.round(seconds * 1000) / 1000;
  const days = Math.floor(rounded / 86400);
  const hours = Math.floor(rounded / 3600) % 24;
  const minutes = Math.floor(rounded / 60) % 60;
  const remainder = rounded % 60;
  const secondsLabel = remainder.toFixed(3).replace(/\.?0+$/, '') || '0';

  const paddedSeconds = `${remainder < 10 ? '0' : ''}${secondsLabel}`;

  if (rounded < 3600) return `${minutes}:${paddedSeconds}`;

  return `${days ? `${days}d ` : ''}${hours}h ${String(minutes).padStart(2, '0')}m ${paddedSeconds}s`;
}

export function renderTimeline(container, entries, { selected, disabled, onSelect }) {
  const document = container.ownerDocument;
  const known = entries.reduce((sum, entry) => sum + (entry.seconds ?? 0), 0);
  const markers = entries.filter((entry) => entry.seconds === null || entry.seconds === 0).length;

  // A bounded canvas allows long drafts to scroll without losing occurrences.
  container.style.width = `${Math.min(32000, Math.max(640, known * 0.35 + markers * 36))}px`;
  container.replaceChildren();

  const span = (className, text) => {
    const node = document.createElement('span');

    node.className = className;
    node.textContent = text;

    return node;
  };

  entries.forEach((entry) => {
    const button = document.createElement('button');
    const unknown = entry.seconds === null;

    button.className = `timeline-entry${unknown ? ' duration-unknown' : ''}`;
    // Fixed-width markers are explicitly outside the time scale. Known positive
    // durations share exactly one scale, including very short tracks.
    button.style.flex = entry.seconds > 0 ? `${entry.seconds} 0 0px` : '0 0 36px';
    button.disabled = disabled;
    button.dataset.focus = `timeline-${entry.entry_id}`;
    button.setAttribute('aria-pressed', String(selected.includes(entry.entry_id)));
    const label = `Entry ${entry.position}: ${entry.title}, ${entry.artist}. Duration ${unknown ? 'unknown' : clockLabel(entry.seconds)}. Starts ${clockLabel(entry.start)}; ends ${clockLabel(entry.end)}. Tempo ${entry.bpm ?? 'unknown'}${entry.bpm === null ? '' : ' BPM'}. Key ${entry.key ?? 'unknown'}.`;

    button.setAttribute('aria-label', label);
    button.title = label;
    button.onclick = () => onSelect(entry.entry_id);
    const artist = span('timeline-artist', entry.artist);
    // Color is only a reading aid: the raw artist name is always available.
    let hash = 0;

    for (const char of entry.artist.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)) | 0;

    artist.dataset.color = String(Math.abs(hash) % 6);
    button.append(
      span('timeline-start', entry.start === null ? '? elapsed' : clockLabel(entry.start)),
      span('timeline-block', `${String(entry.position).padStart(2, '0')} ${entry.title}`),
      artist,
      span('timeline-tempo', entry.bpm === null ? '? BPM' : `${entry.bpm} BPM`),
      span('timeline-key', entry.key ?? '? key'),
      span('timeline-duration', unknown ? '?' : clockLabel(entry.seconds)),
    );
    container.append(button);
  });
}
