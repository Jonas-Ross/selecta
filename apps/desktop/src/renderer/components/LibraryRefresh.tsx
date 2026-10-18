// Refresh the library from Music.app, and say when it was last read and how the
// last refresh went.
import { useEffect, useState } from 'react';
import type { LibraryView } from '../../shared/protocol.js';
import { refreshLibrary } from '../hooks/useLibrary.js';
import { libraryLine, working } from '../library.js';

export function LibraryRefresh({
  view,
  compact,
  onError,
}: {
  view: LibraryView | undefined;
  /** Beside the crate's search: the button alone, its ring showing progress and its tooltip the words. */
  compact?: boolean;
  onError: (message: string) => void;
}) {
  const [now, setNow] = useState(Date.now);

  // "Read 3 min ago" has to keep up with the clock.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);

    return () => clearInterval(timer);
  }, []);

  if (!view) return null;

  const busy = working(view);
  const line = libraryLine(view, Math.max(now, view.read_at ?? 0));
  const progress = view.measuring && view.measuring.done / Math.max(1, view.measuring.of);

  return (
    <div className={compact ? 'library compact' : 'library'}>
      {!compact && (
        <span
          className={line.failed ? 'library-line mono failed' : 'library-line mono'}
          role="status"
        >
          {line.text}
        </span>
      )}
      <button
        type="button"
        className={`btn line${compact ? ' icon' : ''}${compact && line.failed ? ' failed' : ''}`}
        disabled={busy}
        aria-label={compact ? `Refresh library. ${line.text}` : undefined}
        title={compact ? line.text : undefined}
        style={
          progress !== undefined
            ? ({ '--progress': `${progress}turn` } as React.CSSProperties)
            : undefined
        }
        onClick={() => void refreshLibrary().catch((e: Error) => onError(e.message))}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className={busy ? 'spin' : undefined}>
          <path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1" />
          <path d="M12.2 1.6v2.8H9.4" />
        </svg>
        {!compact && 'Refresh library'}
      </button>
    </div>
  );
}

/** Why the last refresh fell short, in words first and the system's own after. */
export function LibraryFailure({ view }: { view: LibraryView | undefined }) {
  if (!view?.failed) return null;

  return (
    <p className="notice error library-failure">
      <span>
        <b>
          {view.failed === 'read'
            ? "Couldn't read your library from Music."
            : 'Your library was read, but new tracks couldn’t be measured.'}
        </b>{' '}
        {view.error}
      </span>
    </p>
  );
}
