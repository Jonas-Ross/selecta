import { useEffect, useState, type FormEvent } from 'react';
import { selecta } from '../api.js';
import { pickProvider, rememberProvider } from '../providers.js';
import { BRIEF_LIMIT, type ProviderId, type ProviderStatus } from '../../shared/protocol.js';
import { TopBar } from './TopBar.js';

export function Brief({
  onCancel,
  onStart,
}: {
  onCancel: () => void;
  onStart: (brief: string, provider?: ProviderId) => void;
}) {
  const [providers, setProviders] = useState<ProviderStatus[]>();
  const [provider, setProvider] = useState<ProviderId>();

  useEffect(() => {
    selecta
      .call('agent.providers')
      .then((found) => {
        setProviders(found);
        setProvider((current) => current ?? pickProvider(found));
      })
      // Without the list the host's default still runs, and says what's missing if it can't.
      .catch(() => setProviders([]));
  }, []);

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

    if (provider) rememberProvider(provider);

    onStart(brief, provider);
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
          {providers && providers.length > 1 && (
            <fieldset className="field agents">
              <legend className="field-label">Built by</legend>
              <div className="agent-choice">
                {providers.map((option) => (
                  <label key={option.id} title={option.problem}>
                    <input
                      type="radio"
                      name="agent"
                      value={option.id}
                      checked={provider === option.id}
                      disabled={!option.ready}
                      onChange={() => setProvider(option.id)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
              {providers
                .filter((option) => !option.ready)
                .map((option) => (
                  <p key={option.id} className="hint">
                    {option.label}: {option.problem}
                  </p>
                ))}
            </fieldset>
          )}
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
            {label(providers, provider)} searches your library and lays a draft on the rail. Nothing
            reaches Music.app until you save.
          </p>
        </form>
      </main>
    </>
  );
}

const label = (found: ProviderStatus[] | undefined, id: ProviderId | undefined) =>
  found?.find((option) => option.id === id)?.label ?? 'Claude';
