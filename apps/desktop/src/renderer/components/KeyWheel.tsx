// The Camelot wheel with this set's route drawn through it: past solid, ahead
// dashed, now and next marked. Positions only; no route is better than another.
import { memo } from 'react';
import { wheelCell, wheelPoint, wheelRoute } from '../listen.js';
import type { Row } from '../state.js';
import { Term } from './Explain.js';

const NUMBERS = Array.from({ length: 12 }, (_, i) => i + 1);

export const KeyWheel = memo(function KeyWheel({ items, now }: { items: Row[]; now: number }) {
  const camelots = items.map((row) => row.camelot);
  const used = new Set(camelots.flatMap((camelot) => camelot?.toUpperCase() ?? []));
  const here = wheelPoint(items[now]?.camelot);
  const next = wheelPoint(items[now + 1]?.camelot);
  const name = (row?: Row) =>
    row?.camelot ? `${row.camelot} ${row.musical_key ?? ''}` : 'not measured';

  return (
    <div className="wheel">
      <span className="ls-lab">
        <Term name="camelot">Key wheel</Term>
      </span>
      <svg
        viewBox="-150 -150 300 300"
        role="img"
        aria-label="Camelot key wheel with the set's route"
      >
        {(['A', 'B'] as const).flatMap((mode) =>
          NUMBERS.map((n) => {
            const on = used.has(`${n}${mode}`);
            const [x, y] = wheelPoint(`${n}${mode}`, 'label')!;

            return (
              <g key={`${n}${mode}`}>
                <path className={on ? 'cell on' : 'cell'} d={wheelCell(n, mode)} />
                <text className={on ? 'wl on' : 'wl'} x={x.toFixed(1)} y={y.toFixed(1)}>
                  {n}
                  {mode}
                </text>
              </g>
            );
          }),
        )}
        <path className="route" d={wheelRoute(camelots, now, items.length - 1)} />
        <path className="route past" d={wheelRoute(camelots, 0, now)} />
        {next && <circle className="nextp" cx={next[0]} cy={next[1]} r="8" />}
        {here && <circle className="nowp" cx={here[0]} cy={here[1]} r="5" />}
      </svg>
      <p className="wheel-now">
        <span className="mono">now</span> {name(items[now])}
        <span className="mono">next</span> {now + 1 < items.length ? name(items[now + 1]) : 'none'}
      </p>
    </div>
  );
});
