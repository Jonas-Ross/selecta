import { reconcileChildren, element } from './reconcile.js';

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

// Six fixed hues: enough to tell neighbours apart, never a claim of identity.
// Color is only a reading aid; the raw artist name is always shown.
const ARTIST_COLORS = [
  'light-dark(#38647f, #85b4d0)',
  'light-dark(#785b8f, #b6a0cd)',
  'light-dark(#8a602d, #ccae7d)',
  'light-dark(#366f5e, #8cbfaf)',
  'light-dark(#905562, #d39aaa)',
  'light-dark(#656c2a, #b8c180)',
];

function artistColor(artist) {
  let hash = 0;

  for (const char of artist.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)) | 0;

  return ARTIST_COLORS[Math.abs(hash) % ARTIST_COLORS.length];
}

const LANES = [
  'timeline-start',
  'timeline-block',
  'timeline-artist',
  'timeline-tempo',
  'timeline-key',
  'timeline-duration',
];

export function renderTimeline(container, entries, { selected, disabled, onSelect }) {
  const document = container.ownerDocument;
  const glyph = (value) => (value === null ? '?' : clockLabel(value));
  const selectedIds = new Set(selected);
  const known = entries.reduce((sum, entry) => sum + (entry.seconds ?? 0), 0);
  const unknownCount = entries.filter((entry) => entry.seconds === null).length;
  const width = known * PX_PER_SECOND + unknownCount * MARKER_PX;

  container.style.width = `${Math.min(MAX_WIDTH_PX, Math.max(MIN_WIDTH_PX, width))}px`;
  reconcileChildren(container, entries, {
    create: () => {
      const button = document.createElement('button');

      button.className = 'timeline-entry';
      button.append(...LANES.map((className) => element(document, 'span', className)));

      return button;
    },
    update: (button, entry) => {
      const unknown = entry.seconds === null;
      const label = `Entry ${entry.position}: ${entry.title}, ${entry.artist}. Duration ${unknown ? 'unknown' : clockLabel(entry.seconds)}. Starts ${clockLabel(entry.start)}; ends ${clockLabel(entry.end)}. Tempo ${entry.bpm === null ? 'unknown' : `${entry.bpm} BPM`}. Key ${entry.key ?? 'unknown'}.`;
      const [start, block, artist, tempo, key, duration] = button.children;

      button.classList.toggle('duration-unknown', unknown);
      // Known durations share one scale; unknown markers sit outside it.
      button.style.flex = unknown ? `0 0 ${MARKER_PX}px` : `${entry.seconds} 0 0px`;
      button.disabled = disabled;
      button.setAttribute('aria-pressed', String(selectedIds.has(entry.entry_id)));
      button.setAttribute('aria-label', label);
      button.title = label;
      button.onclick = () => onSelect(entry.entry_id);
      start.textContent = glyph(entry.start);
      block.textContent = `${String(entry.position).padStart(2, '0')} ${entry.title}`;
      artist.textContent = entry.artist;
      artist.style.borderTopColor = artistColor(entry.artist);
      tempo.textContent = entry.bpm === null ? '? BPM' : `${entry.bpm} BPM`;
      key.textContent = entry.key ?? '? key';
      duration.textContent = glyph(entry.seconds);
    },
  });
}
