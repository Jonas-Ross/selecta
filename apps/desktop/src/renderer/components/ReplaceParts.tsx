// Pieces the shortlist and the bench share.
import { useState } from 'react';
import { ASK_LIMIT } from '../../shared/protocol.js';
import { join } from '../joins.js';
import type { Track } from '../state.js';
import { Glyph } from './JoinMarker.js';

export const factsText = (track: Track) =>
  `${track.bpm === undefined ? 'no tempo' : Math.round(track.bpm)} · ${track.camelot ?? 'no key'}`;

/** One join as the rail's markers show it: the wheel glyph, the tempo step, the key relation. */
export function Fit({ from, to }: { from: Track; to: Track }) {
  const facts = join(from, to);

  return (
    <>
      <Glyph from={facts.from} to={facts.to} />
      <span className="fit-tempo">{facts.tempo}</span>
      <span className="fit-words">{facts.words}</span>
    </>
  );
}

export function PlayIcon({ playing = false }: { playing?: boolean }) {
  return (
    <svg className="play-icon" viewBox="0 0 12 12" aria-hidden="true">
      {playing ? <path d="M3.5 2.5v7M8.5 2.5v7" /> : <path d="M3.5 2v8l6-4z" />}
    </svg>
  );
}

/** Three bars, for the pick Music is playing. */
export const Eq = () => (
  <span className="eq" aria-hidden="true">
    <i />
    <i />
    <i />
  </span>
);

export function Steer({
  agent,
  hint,
  onAsk,
}: {
  agent: string;
  hint: string;
  onAsk: (text: string) => void;
}) {
  const [text, setText] = useState('');

  return (
    <form
      className="steer"
      onSubmit={(e) => {
        e.preventDefault();

        if (!text.trim()) return;

        onAsk(text.trim());
        setText('');
      }}
    >
      <input
        aria-label={`Ask ${agent} for something else`}
        placeholder={hint}
        maxLength={ASK_LIMIT}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <kbd className="mono">↵</kbd>
    </form>
  );
}
