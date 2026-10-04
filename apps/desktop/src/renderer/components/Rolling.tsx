// A number that rolls to its new value on a spring instead of jumping.
import { useEffect, useRef, useState } from 'react';
import { useFrameLoop, useReducedMotion } from '../hooks/motion.js';
import { rest, settled, SLIDE, stepSpring } from '../springs.js';

export function Rolling({ value }: { value: number }) {
  const reduced = useReducedMotion();
  const spring = useRef(rest(value));
  const [shown, setShown] = useState(value);
  const kick = useFrameLoop((dt) => {
    spring.current = stepSpring(spring.current, value, SLIDE, dt);

    const done = settled(spring.current, value, 0.01);

    setShown(done ? value : Math.round(spring.current.x));

    return !done;
  });

  useEffect(() => {
    if (reduced) {
      spring.current = rest(value);
      setShown(value);
    } else kick();
  }, [value, reduced, kick]);

  return <span className={shown === value ? 'num' : 'num rolling'}>{shown}</span>;
}
