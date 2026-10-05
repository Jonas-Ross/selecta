// A record in the air between the crate and the rail. It is drawn once at
// its starting box and moved by the compositor along an arc to where it lands.
import { useLayoutEffect, useRef } from 'react';
import { arcFrames, type Rect } from '../flight.js';
import { Sleeve } from './Sleeve.js';

export type FlightPlan = { key: number; trackId: string; title?: string; from: Rect; to: Rect };

// Long enough to read as a throw, short enough that adding many records stays quick.
const DURATION = 560;

export function Flight({
  plan,
  reduced,
  onLanded,
}: {
  plan: FlightPlan;
  reduced: boolean;
  onLanded: () => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  const done = useRef(onLanded);

  done.current = onLanded;

  useLayoutEffect(() => {
    const animation = node.current!.animate(arcFrames(plan.from, plan.to), {
      duration: reduced ? 1 : DURATION,
      easing: 'cubic-bezier(.3,.1,.25,1)',
      fill: 'forwards',
    });

    animation.onfinish = () => done.current();

    return () => animation.cancel();
  }, [plan, reduced]);

  return (
    <div
      ref={node}
      className="flight"
      aria-hidden="true"
      style={{
        left: plan.from.left,
        top: plan.from.top,
        width: plan.from.width,
        height: plan.from.width,
      }}
    >
      <Sleeve trackId={plan.trackId} title={plan.title} />
    </div>
  );
}
