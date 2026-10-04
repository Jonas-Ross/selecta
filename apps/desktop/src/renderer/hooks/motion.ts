// The two pieces of motion every component shares: the user's reduced-motion
// setting, and a frame loop that runs only while something is moving.
import { useEffect, useRef, useState } from 'react';

const query = '(prefers-reduced-motion: reduce)';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matchMedia(query).matches);

  useEffect(() => {
    const media = matchMedia(query);
    const change = () => setReduced(media.matches);

    media.addEventListener('change', change);

    return () => media.removeEventListener('change', change);
  }, []);

  return reduced;
}

/**
 * Calls `step(dt)` each animation frame until it returns false, and returns
 * `kick` to start it again. dt is capped so a backgrounded window resumes calmly.
 */
export function useFrameLoop(step: (dt: number) => boolean): () => void {
  const latest = useRef(step);
  const frame = useRef(0);

  latest.current = step;

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const kick = useRef(() => {
    if (frame.current) return;

    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);

      last = now;
      frame.current = latest.current(dt) ? requestAnimationFrame(loop) : 0;
    };

    frame.current = requestAnimationFrame(loop);
  });

  return kick.current;
}
