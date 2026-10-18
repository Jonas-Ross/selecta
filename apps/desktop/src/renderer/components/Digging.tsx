// The empty rail while the agent builds: white labels stand where records will,
// a flick runs through them, and one at a time a disc is pulled half out.
import { useEffect, useState } from 'react';
import { digStep, ghostCount, nextPull } from '../digging.js';
import { useReducedMotion } from '../hooks/motion.js';
import { GUTTER, slotX, type Shelf } from '../lanes.js';

// Long enough to read the step line between pulls.
const PULL_MS = 2600;

export function Digging({
  agent,
  shelf,
  view,
  tool,
  calls,
}: {
  agent: string;
  shelf: Shelf;
  view: number;
  /** The latest tool call, as the log names it. */
  tool?: string;
  /** How many tool calls the run has made; each one pulls the next record. */
  calls: number;
}) {
  const reduced = useReducedMotion();
  const count = ghostCount(view, shelf.step, shelf.gap);
  const [pull, setPull] = useState({ at: Math.min(1, count - 1), turn: 0 });

  useEffect(() => {
    if (reduced) return;

    const timer = setInterval(
      () => setPull(({ at, turn }) => ({ at: nextPull(at, turn, count), turn: turn + 1 })),
      PULL_MS,
    );

    return () => clearInterval(timer);
  }, [reduced, count, calls]);

  useEffect(() => {
    if (calls && !reduced)
      setPull(({ at, turn }) => ({ at: nextPull(at, turn, count), turn: turn + 1 }));
  }, [calls, reduced, count]);

  const pulled = pull.at % count;

  return (
    <div className="digging" role="status">
      <div
        className="digging-say"
        style={{ left: GUTTER, top: shelf.tempo.top, height: shelf.tempo.height }}
      >
        <b>{agent} is digging</b>
        <span key={tool} className="digging-step">
          {digStep(tool)}
        </span>
      </div>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className={i === pulled ? 'ghost pulled' : 'ghost'}
          aria-hidden="true"
          style={{
            // Where RailRecord stands the record that replaces it.
            left: GUTTER + slotX(i, shelf.step) + shelf.gap / 2,
            top: shelf.rail - shelf.size,
            width: shelf.size,
            height: shelf.size,
            ['--i' as string]: i,
          }}
        >
          <div className="ghost-body">
            <div className="ghost-disc">
              <i />
            </div>
            <div className="sleeve ghost-sleeve">
              <svg className="sleeve-ring" viewBox="0 0 100 100">
                <circle className="groove" cx="50" cy="62" r={24 + (i % 3) * 2} />
                <circle className="groove" cx="50" cy="62" r={28 + (i % 3) * 2} />
                <circle className="label" cx="50" cy="62" r={16 + ((i * 5) % 6)} />
                <circle className="hole" cx="50" cy="62" r="1.6" />
              </svg>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
