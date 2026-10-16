// Listening mode: the draft full screen for just listening. The sleeve plain in
// the middle, the record turning behind it, and the draft as a dock of sleeves
// with the playing one opened out. The controls fade while you listen.
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Listening } from '../hooks/useListen.js';
import { useReducedMotion } from '../hooks/motion.js';
import { useScrub } from '../hooks/useScrub.js';
import { join } from '../joins.js';
import { formatClock } from '../lanes.js';
import { usePalette } from '../palette.js';
import type { Row } from '../state.js';
import { dockShift } from '../turntable.js';
import { Sleeve } from './Sleeve.js';
import { Turntable } from './Turntable.js';

// The controls fade after this long without the pointer or keys, while music plays.
const IDLE_MS = 3000;
// Dock geometry in px, mirrored in listening.css through the custom properties set below.
const TILE = 40;
const WIDE = 340;
const GAP = 8;
// The next sleeve nudges for attention this many seconds before the record ends.
const SOON = 40;

export function ListeningMode({
  name,
  items,
  listen,
  disabled,
  joinDisabled,
  onClose,
}: {
  name: string;
  items: Row[];
  listen: Listening;
  /** The transport is held: Claude is working, an edit is landing, or Music is busy. */
  disabled: boolean;
  joinDisabled: boolean;
  onClose: () => void;
}) {
  const row = listen.nowRow;
  const next = items[listen.now + 1];
  const palette = usePalette(row?.track_id);
  const still = useReducedMotion();
  const sleeve = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const idle = useIdle(listen.playing);
  const j = row && next && join(row, next);
  const left = listen.duration ? Math.max(0, listen.duration - listen.position) : undefined;

  useFullscreen(onClose);
  useModal(dialog);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === ' ' && !(e.target as Element).closest('button, input') && !disabled) {
        e.preventDefault();
        listen.toggle();
      }
    };

    addEventListener('keydown', key);

    return () => removeEventListener('keydown', key);
  });

  return createPortal(
    <div
      ref={dialog}
      tabIndex={-1}
      className={`lm${idle ? ' idle' : ''}${still ? ' still' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Listening mode"
      style={palette && ({ '--tint-a': palette.a, '--tint-b': palette.b } as CSSProperties)}
    >
      <Turntable
        records={items.map((r) => ({ id: r.track_id, seconds: r.duration_seconds }))}
        now={listen.now}
        position={listen.position}
        duration={listen.duration ?? row?.duration_seconds}
        playing={listen.playing}
        bpm={row?.bpm}
        palette={palette}
        sleeve={sleeve}
        still={still}
      />
      <header className="lm-top lm-chrome">
        <span className="lm-set">
          <b>{name}</b>
          <span className="mono">
            {listen.current ? (listen.playing ? 'Now playing' : 'Paused') : 'Cued'} · record{' '}
            {listen.now + 1} of {items.length}
          </span>
        </span>
        {!still && <span className="lm-hint mono">Grab the record to spin it</span>}
        <button type="button" className="btn line sm" onClick={onClose}>
          Done
        </button>
      </header>
      {row && (
        <div className="lm-centre">
          <div className="lm-sleeve" ref={sleeve} key={row.entry_id}>
            <Sleeve trackId={row.track_id} title={row.title} />
          </div>
          <div className="lm-meta">
            <h1>{row.title ?? 'Untitled'}</h1>
            <p>{row.artist ?? 'Unknown artist'}</p>
            {listen.status && <p className="lm-status mono">{listen.status}</p>}
          </div>
        </div>
      )}
      {next && j && (
        <aside className="lm-next lm-chrome" aria-label="Up next">
          <Sleeve trackId={next.track_id} title={next.title} />
          <span>
            <span className="lm-lab mono">Up next</span>
            <b>{next.title ?? 'Untitled'}</b>
            <span>
              {j.tempo} · {j.words}
            </span>
          </span>
        </aside>
      )}
      <footer className="lm-bottom lm-chrome">
        <Dock
          items={items}
          now={listen.now}
          soon={listen.playing && left !== undefined && left < SOON}
          disabled={disabled}
          position={listen.position}
          duration={listen.duration ?? row?.duration_seconds}
          left={left}
          onPlay={listen.play}
          onSeek={listen.current ? (at) => void listen.player.seek(at) : undefined}
        />
        <div className="lm-transport">
          <button
            type="button"
            className="lm-round"
            aria-label="Previous record"
            disabled={disabled || !listen.canPrev}
            onClick={listen.prev}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 5h2v14H6zM20 5 9.5 12 20 19z" />
            </svg>
          </button>
          <button
            type="button"
            className={`lm-round play${listen.playing ? ' on' : ''}`}
            aria-label={listen.playing ? 'Pause' : 'Play'}
            disabled={disabled || !row}
            onClick={listen.toggle}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {listen.playing ? (
                <path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z" />
              ) : (
                <path d="M7 4.5 20 12 7 19.5z" />
              )}
            </svg>
          </button>
          <button
            type="button"
            className="lm-round"
            aria-label="Next record"
            disabled={disabled || listen.now + 1 >= items.length}
            onClick={listen.next}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M16 5h2v14h-2zM4 5l10.5 7L4 19z" />
            </svg>
          </button>
        </div>
        <div className="lm-foot">
          <button
            type="button"
            className="btn line sm"
            disabled={joinDisabled}
            onClick={listen.join}
          >
            Hear the transition
          </button>
          <span className="mono">Plays through Music.app</span>
        </div>
      </footer>
    </div>,
    document.body,
  );
}

function Dock({
  items,
  now,
  soon,
  disabled,
  position,
  duration,
  left,
  onPlay,
  onSeek,
}: {
  items: Row[];
  now: number;
  soon: boolean;
  disabled: boolean;
  position: number;
  duration?: number;
  left?: number;
  onPlay: (index: number) => void;
  onSeek?: (position: number) => void;
}) {
  const row = items[now];
  const { shown, move, commit, cancel } = useScrub(row?.entry_id, position, onSeek);

  return (
    <div
      className={`lm-dock${soon ? ' soon' : ''}`}
      style={{ '--tile': `${TILE}px`, '--wide': `${WIDE}px`, '--gap': `${GAP}px` } as CSSProperties}
    >
      <ol
        className="lm-run"
        aria-label="Playlist"
        style={{ transform: `translateX(${dockShift(now, TILE, WIDE, GAP)}px)` }}
      >
        {items.map((r, i) =>
          i === now ? (
            <li key={r.entry_id} className="lm-tile now" aria-current="true">
              <Sleeve trackId={r.track_id} title={r.title} />
              <span className="lm-tile-text">
                <b>{r.title ?? 'Untitled'}</b>
                <input
                  className="lm-scrub"
                  type="range"
                  min={0}
                  max={Math.max(1, Math.round(duration ?? 1))}
                  step={1}
                  value={Math.round(shown)}
                  disabled={disabled || !onSeek || duration === undefined}
                  aria-label="Position in track"
                  aria-valuetext={`${formatClock(shown)} of ${duration === undefined ? 'unknown' : formatClock(duration)}`}
                  style={{ '--at': `${duration ? (shown / duration) * 100 : 0}%` } as CSSProperties}
                  onChange={(e) => move(Number(e.target.value))}
                  onPointerUp={commit}
                  onKeyUp={commit}
                  onBlur={cancel}
                />
              </span>
              <span className="lm-tile-time mono">
                {left === undefined
                  ? formatClock(position)
                  : `${items[now + 1] ? 'Transition' : 'Ends'} in ${formatClock(left)}`}
              </span>
            </li>
          ) : (
            <li
              key={r.entry_id}
              className={`lm-tile${i < now ? ' past' : ''}${i === now + 1 ? ' next' : ''}`}
            >
              <button
                type="button"
                aria-label={`Play ${r.title ?? 'Untitled'}`}
                title={r.title}
                disabled={disabled}
                onClick={() => onPlay(i)}
              >
                <Sleeve trackId={r.track_id} title={r.title} />
              </button>
            </li>
          ),
        )}
      </ol>
    </div>
  );
}

/** True once the pointer and keys have been still for a while during playback. */
function useIdle(playing: boolean): boolean {
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    setIdle(false);

    if (!playing) return;

    let timer = setTimeout(() => setIdle(true), IDLE_MS);
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), IDLE_MS);
    };
    const events = ['pointermove', 'pointerdown', 'keydown'] as const;

    events.forEach((name) => addEventListener(name, wake));

    return () => {
      clearTimeout(timer);
      events.forEach((name) => removeEventListener(name, wake));
    };
  }, [playing]);

  return idle;
}

/** Takes focus into the dialog and makes the screen under it inert, giving focus back on close. */
function useModal(dialog: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const root = document.getElementById('root');
    const before = document.activeElement as HTMLElement | null;

    if (root) root.inert = true;

    dialog.current?.focus();

    return () => {
      if (root) root.inert = false;

      before?.focus();
    };
  }, [dialog]);
}

/** Takes the window full screen while open; leaving full screen another way closes it too. */
function useFullscreen(onExit: () => void) {
  const exit = useRef(onExit);

  exit.current = onExit;

  useEffect(() => {
    let entered = false;
    const change = () => {
      if (document.fullscreenElement) entered = true;
      else if (entered) exit.current();
    };

    document.addEventListener('fullscreenchange', change);
    // Refused without a recent click; the overlay still fills the window.
    document.documentElement.requestFullscreen?.().catch(() => {});

    return () => {
      document.removeEventListener('fullscreenchange', change);

      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);
}
