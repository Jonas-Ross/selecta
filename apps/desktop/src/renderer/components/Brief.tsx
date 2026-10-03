import { useState, type FormEvent } from 'react';
import { BRIEF_LIMIT } from '../../shared/protocol.js';
import { TopBar } from './TopBar.js';

export function Brief({
  onCancel,
  onStart,
}: {
  onCancel: () => void;
  onStart: (brief: string) => void;
}) {
  const [text, setText] = useState('');
  const [length, setLength] = useState('');
  const [tempo, setTempo] = useState('');

  const brief = [
    text.trim(),
    length && `Length: about ${length} tracks.`,
    tempo && `Tempo: ${tempo} BPM.`,
  ]
    .filter(Boolean)
    .join('\n');
  // Checked here as well as in the host, so an over-long brief stays on screen to fix.
  const tooLong = brief.length > BRIEF_LIMIT;

  function submit(event: FormEvent) {
    event.preventDefault();
    onStart(brief);
  }

  return (
    <>
      <TopBar onHome={onCancel} crumb={<h1 className="crumb-title">New playlist</h1>} />
      <main className="page">
        <form className="column brief" onSubmit={submit}>
          <div className="page-head">
            <h1>What are you after?</h1>
          </div>
          <label className="field">
            <span className="field-label">The brief</span>
            <textarea
              autoFocus
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Late-night deep house that builds slowly, nothing too vocal"
            />
          </label>
          <div className="fields">
            <label className="field">
              <span className="field-label">Tracks</span>
              <input
                inputMode="numeric"
                value={length}
                onChange={(e) => setLength(e.target.value)}
                placeholder="10"
              />
            </label>
            <label className="field">
              <span className="field-label">Tempo, BPM</span>
              <input
                value={tempo}
                onChange={(e) => setTempo(e.target.value)}
                placeholder="118-124"
              />
            </label>
          </div>
          {tooLong && <p className="notice">Keep the brief under {BRIEF_LIMIT} characters.</p>}
          <div className="actions">
            <button type="button" className="btn line" onClick={onCancel}>
              Cancel
            </button>
            <button className="btn uv" disabled={!text.trim() || tooLong}>
              Build it
            </button>
          </div>
          <p className="hint">
            Claude searches your library and lays a draft on the rail. Nothing reaches Music.app
            until you save.
          </p>
        </form>
      </main>
    </>
  );
}
