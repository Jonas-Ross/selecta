// The window's top bar: a drag region with room for the traffic lights, the
// mark, a crumb, and whatever the screen puts on the right.
import type { ReactNode } from 'react';

/** The website's groove mark: one spiral groove and three kicks on it. */
export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <path
        className="groove"
        d="M16.0 12.5 16.6 12.4 17.1 12.5 17.7 12.6 18.3 12.8 18.8 13.2 19.3 13.6 19.7 14.1 20.1 14.7 20.3 15.3 20.5 16.0 20.5 16.7 20.5 17.5 20.3 18.2 20.0 18.9 19.5 19.5 19.0 20.1 18.4 20.6 17.6 21.0 16.8 21.3 16.0 21.5 15.1 21.5 14.2 21.4 13.4 21.2 12.5 20.8 11.8 20.2 11.1 19.6 10.5 18.8 10.0 17.9 9.7 17.0 9.5 16.0 9.5 15.0 9.6 13.9 9.9 12.9 10.4 11.9 11.1 11.1 11.8 10.3 12.7 9.6 13.7 9.1 14.8 8.7 16.0 8.5 17.2 8.5 18.4 8.7 19.5 9.1 20.6 9.6 21.7 10.3 22.6 11.2 23.3 12.3 23.9 13.4 24.3 14.7 24.5 16.0 24.5 17.3 24.3 18.7 23.8 20.0 23.2 21.2 22.4 22.4 21.3 23.4 20.2 24.2 18.9 24.8 17.5 25.3 16.0 25.5 14.5 25.5 13.0 25.2 11.6 24.7 10.2 24.0 8.9 23.1 7.8 21.9 6.9 20.6 6.2 19.2 5.7 17.6 5.5 16.0 5.5 14.3 5.8 12.7 6.4 11.1 7.2 9.6 8.2 8.2 9.5 7.0 10.9 6.0 12.5 5.3 14.2 4.7 16.0 4.5 17.8 4.5 19.6 4.9 21.4 5.5 23.0 6.4 24.5 7.5 25.8 8.9 26.9 10.5 27.7 12.2 28.2 14.1 28.5 16.0 28.4 18.0 28.1 19.9 27.4 21.8 26.4 23.6 25.2 25.2 23.7 26.6 22.0 27.8 20.1 28.6 18.1 29.2 16.0 29.5"
      />
      <circle className="kick" cx="16" cy="12.5" r="2" transform="rotate(34 16 16)" />
      <circle className="kick" cx="16" cy="8.5" r="2" transform="rotate(-48 16 16)" />
      <circle className="kick" cx="16" cy="4.5" r="2" transform="rotate(66 16 16)" />
    </svg>
  );
}

export function TopBar({
  onHome,
  homeDisabled,
  crumb,
  right,
}: {
  onHome?: () => void;
  homeDisabled?: boolean;
  crumb?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="crumb">
        {onHome ? (
          <button
            type="button"
            className="brand"
            onClick={onHome}
            disabled={homeDisabled}
            aria-label="All drafts"
          >
            <Mark />
            <span className="wordmark">Selecta</span>
          </button>
        ) : (
          <span className="brand">
            <Mark />
            <span className="wordmark">Selecta</span>
          </span>
        )}
        {crumb && (
          <>
            <span className="sep" aria-hidden="true">
              /
            </span>
            {crumb}
          </>
        )}
      </div>
      {right && <div className="topbar-right">{right}</div>}
    </header>
  );
}
