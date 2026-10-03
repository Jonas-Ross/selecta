// Claude, docked right: the brief, the run's log, and the feedback box.
// Selected records ride above the box as the subject of what you type.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { LogItem, Row } from '../state.js';

type Group = { kind: 'tools'; names: string[] } | LogItem;

/** Consecutive tool calls read as one row of chips. */
function group(log: LogItem[]): Group[] {
  const out: Group[] = [];

  for (const item of log) {
    const last = out.at(-1);

    if (item.kind !== 'tool') out.push(item);
    else if (last?.kind === 'tools') last.names.push(item.text);
    else out.push({ kind: 'tools', names: [item.text] });
  }

  return out;
}

export function ClaudePanel({
  log,
  working,
  hasDraft,
  locked,
  selected,
  onUnselect,
  onSend,
  onStop,
}: {
  log: LogItem[];
  working: boolean;
  hasDraft: boolean;
  locked: boolean;
  selected: Row[];
  onUnselect: (entryId: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  // The brief opens the run; it sits above the log rather than repeating in it.
  const briefAt = log.findIndex((item) => item.kind === 'you');
  const brief = briefAt >= 0 ? log[briefAt].text : undefined;
  const rest = group(log.filter((_, index) => index !== briefAt));

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [log, working]);

  function submit(event: FormEvent) {
    event.preventDefault();

    // Enter submits too, so the button's guards are repeated here.
    if (working || locked || !text.trim()) return;

    onSend(text.trim());
    setText('');
  }

  return (
    <aside className="claude" aria-label="Claude">
      <div className="claude-head">
        <h2>Claude</h2>
        <span className={working ? 'state working' : 'state'}>{working ? 'working' : 'ready'}</span>
      </div>
      {brief && (
        <div className="brief-card">
          <b>Brief</b>
          {brief}
        </div>
      )}
      <div className="log" role="log" aria-live="polite">
        {rest.map((item, index) =>
          item.kind === 'tools' ? (
            <div key={index} className="chips">
              {item.names.map((name, k) => (
                <span
                  key={k}
                  className={
                    working && index === rest.length - 1 && k === item.names.length - 1
                      ? 'chip run'
                      : 'chip'
                  }
                >
                  {name}
                </span>
              ))}
            </div>
          ) : (
            <div key={index} className={`msg ${item.kind}`}>
              <span className="who">
                {item.kind === 'you' ? 'You' : item.kind === 'claude' ? 'Claude' : 'Problem'}
              </span>
              {item.text}
            </div>
          ),
        )}
        {working && (
          <div className="working" aria-label="Claude is working">
            <i />
            <i />
            <i />
            <span>working</span>
          </div>
        )}
        <div ref={end} />
      </div>
      <form className="compose" onSubmit={submit}>
        {selected.length > 0 && (
          <div className="subject">
            <span>About these tracks:</span>
            {selected.map((row) => (
              <span key={row.entry_id} className="s">
                {row.title ?? row.track_id}
                <button
                  type="button"
                  aria-label={`Stop talking about ${row.title ?? 'this track'}`}
                  onClick={() => onUnselect(row.entry_id)}
                >
                  <svg viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="box">
          <textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            aria-label="Message to Claude"
            placeholder={
              !hasDraft && !working
                ? 'Describe the playlist to try again'
                : selected.length
                  ? `What should change about ${selected.length === 1 ? 'this track' : 'these tracks'}?`
                  : 'Tell Claude what to change'
            }
          />
          {working ? (
            <button type="button" className="btn line" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button className="btn uv" disabled={!text.trim() || locked}>
              Send
            </button>
          )}
        </div>
        <p className="hint">
          Click records on the rail to talk about them. Selecting never changes the draft.
        </p>
      </form>
    </aside>
  );
}
