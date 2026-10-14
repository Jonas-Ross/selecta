// A notice that opens and closes its own height, so what sits below it slides instead of jumping.
import { type ReactNode, useState } from 'react';
import { useReducedMotion } from '../hooks/motion.js';

/** Shows `children(value)` while `value` is set, and keeps the last value on screen as it closes. */
export function Banner<T>({
  value,
  children,
}: {
  value: T | false | undefined;
  children: (shown: T) => ReactNode;
}) {
  const reduced = useReducedMotion();
  const [held, setHeld] = useState(value || undefined);

  if (value && value !== held) setHeld(value);

  if (!value && held !== undefined && reduced) setHeld(undefined);

  const shown = value || held;

  if (!shown) return null;

  const closing = !value;

  return (
    <div
      className={closing ? 'banner closing' : 'banner'}
      inert={closing}
      onTransitionEnd={(e) => {
        if (closing && e.target === e.currentTarget && e.propertyName === 'grid-template-rows')
          setHeld(undefined);
      }}
    >
      <div>{children(shown)}</div>
    </div>
  );
}
