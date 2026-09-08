// Occurrences stay in draft order. An unknown duration consumes no invented
// time, so the elapsed clock is unknown from the first gap onwards.
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

// m:ss below an hour, explicit units from an hour up (1h 02m 03s, 1d 19h 51m 52s).
export function clockLabel(seconds) {
  if (seconds === null) return 'Unknown';

  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60) % 60;
  const paddedSeconds = String(total % 60).padStart(2, '0');

  if (total < 3600) return `${minutes}:${paddedSeconds}`;

  const days = Math.floor(total / 86400);
  const hours = Math.floor(total / 3600) % 24;

  return `${days ? `${days}d ` : ''}${hours}h ${String(minutes).padStart(2, '0')}m ${paddedSeconds}s`;
}

// Canvas sizing: known seconds scale to pixels, unknown durations get a fixed
// marker, and the total is clamped so a short draft still reads and a
// 500-entry draft scrolls instead of exhausting layout limits.
const PX_PER_SECOND = 0.35;
const MARKER_PX = 36;
const MIN_WIDTH_PX = 640;
const MAX_WIDTH_PX = 32000;
const ARTIST_HUES = 6;

// Color is only a reading aid: the raw artist name is always shown.
function artistHue(artist) {
  let hash = 0;

  for (const char of artist.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)) | 0;

  return String(Math.abs(hash) % ARTIST_HUES);
}

export function renderTimeline(container, entries, { selected, disabled, onSelect }) {
  const document = container.ownerDocument;
  const span = (className, text) => {
    const node = document.createElement('span');

    node.className = className;
    node.textContent = text;

    return node;
  };
  const glyph = (value) => (value === null ? '?' : clockLabel(value));
  const selectedIds = new Set(selected);
  const known = entries.reduce((sum, entry) => sum + (entry.seconds ?? 0), 0);
  const unknownCount = entries.filter((entry) => entry.seconds === null).length;
  const width = known * PX_PER_SECOND + unknownCount * MARKER_PX;

  container.style.width = `${Math.min(MAX_WIDTH_PX, Math.max(MIN_WIDTH_PX, width))}px`;
  container.replaceChildren(
    ...entries.map((entry) => {
      const unknown = entry.seconds === null;
      const button = document.createElement('button');
      const label = `Entry ${entry.position}: ${entry.title}, ${entry.artist}. Duration ${unknown ? 'unknown' : clockLabel(entry.seconds)}. Starts ${clockLabel(entry.start)}; ends ${clockLabel(entry.end)}. Tempo ${entry.bpm === null ? 'unknown' : `${entry.bpm} BPM`}. Key ${entry.key ?? 'unknown'}.`;
      const artist = span('timeline-artist', entry.artist);

      artist.dataset.color = artistHue(entry.artist);
      button.className = `timeline-entry${unknown ? ' duration-unknown' : ''}`;
      // Known durations share one scale; unknown markers sit outside it.
      button.style.flex = unknown ? `0 0 ${MARKER_PX}px` : `${entry.seconds} 0 0px`;
      button.disabled = disabled;
      button.dataset.focus = `timeline-${entry.entry_id}`;
      button.setAttribute('aria-pressed', String(selectedIds.has(entry.entry_id)));
      button.setAttribute('aria-label', label);
      button.title = label;
      button.onclick = () => onSelect(entry.entry_id);
      button.append(
        span('timeline-start', glyph(entry.start)),
        span('timeline-block', `${String(entry.position).padStart(2, '0')} ${entry.title}`),
        artist,
        span('timeline-tempo', entry.bpm === null ? '? BPM' : `${entry.bpm} BPM`),
        span('timeline-key', entry.key ?? '? key'),
        span('timeline-duration', glyph(entry.seconds)),
      );

      return button;
    }),
  );
}
