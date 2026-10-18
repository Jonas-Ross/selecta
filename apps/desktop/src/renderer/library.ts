// How a refresh of the library reads in a line: when Music was last read, what
// a refresh is doing, and how the last one went.
import type { LibraryView } from '../shared/protocol.js';

export function agoText(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);

  if (minutes < 1) return 'just now';

  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);

  if (hours < 24) return `${hours} h ago`;

  const days = Math.floor(hours / 24);

  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export const working = (view: LibraryView | undefined): boolean =>
  Boolean(view?.reading || view?.measuring);

/** The status beside the Refresh button, and whether it reports a failure. */
export function libraryLine(view: LibraryView, now: number): { text: string; failed?: true } {
  if (view.reading) return { text: 'Reading your library…' };

  if (view.measuring) {
    const { done, of } = view.measuring;

    return { text: `Measuring tempo and key · ${done} of ${of}` };
  }

  if (view.failed === 'read') return { text: "Couldn't read your library", failed: true };

  const read = view.read_at == null ? 'Never read' : `Read ${agoText(view.read_at, now)}`;

  if (view.failed === 'measure') return { text: `${read} · couldn't measure`, failed: true };

  const left = view.left ? `, ${view.left.toLocaleString('en-US')} to go` : '';

  return { text: view.measured || left ? `${read} · ${view.measured ?? 0} measured${left}` : read };
}
