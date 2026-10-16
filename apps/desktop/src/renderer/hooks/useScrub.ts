// A position slider over Music's record. Held while dragging, so Music.app gets one
// seek on release rather than one per pixel; bound to the entry it started on, so a
// record that ends mid-drag isn't seeked on the next.
import { useState } from 'react';

export function useScrub(
  entry: string | undefined,
  position: number,
  onSeek: ((position: number) => void) | undefined,
) {
  const [scrub, setScrub] = useState<{ at: number; entry?: string }>();
  const scrubbing = scrub?.entry === entry ? scrub?.at : undefined;

  return {
    shown: scrubbing ?? position,
    move: (at: number) => setScrub({ at, entry }),
    commit: () => {
      if (scrubbing !== undefined) onSeek?.(scrubbing);

      setScrub(undefined);
    },
    cancel: () => setScrub(undefined),
  };
}
