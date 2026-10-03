// Save to Music and its confirm card. The card says exactly what will be
// written before anything is, and stays up with a progress line while it is.
import { useEffect, useRef } from 'react';

export type SavePhase = 'closed' | 'confirm' | 'saving';

export function SaveConfirm({
  phase,
  label,
  disabled,
  done,
  name,
  tracks,
  minutes,
  partial,
  onSave,
  onAnswer,
}: {
  phase: SavePhase;
  label: string;
  disabled: boolean;
  done: boolean; // a recorded attempt: the button stays as its outcome
  name: string;
  tracks: number;
  minutes: number;
  partial: boolean;
  onSave: () => void;
  onAnswer: (ok: boolean) => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const go = useRef<HTMLButtonElement>(null);
  const open = phase !== 'closed';

  useEffect(() => {
    if (phase !== 'confirm') return;

    go.current?.focus();

    const key = (e: KeyboardEvent) => e.key === 'Escape' && onAnswer(false);
    const away = (e: PointerEvent) => !card.current?.contains(e.target as Node) && onAnswer(false);

    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', away);

    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', away);
    };
  }, [phase, onAnswer]);

  return (
    <div className="savewrap">
      <button
        type="button"
        className={done ? 'btn line saved' : 'btn primary'}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onSave}
      >
        {label}
      </button>
      <div
        className={`pop${open ? ' open' : ''}${phase === 'saving' ? ' saving' : ''}`}
        ref={card}
        role="dialog"
        aria-labelledby="save-title"
        aria-hidden={!open}
      >
        <h3 id="save-title">Save to Music</h3>
        <p>
          Creates a new playlist “{name}” in Music.app with these {tracks} tracks ({minutes}
          {partial ? '+' : ''} min). The draft stays here.
        </p>
        <div className="progress" aria-hidden="true">
          <i />
        </div>
        <div className="row">
          <button
            type="button"
            className="btn line"
            disabled={phase !== 'confirm'}
            onClick={() => onAnswer(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn uv"
            ref={go}
            disabled={phase !== 'confirm'}
            onClick={() => onAnswer(true)}
          >
            {phase === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
