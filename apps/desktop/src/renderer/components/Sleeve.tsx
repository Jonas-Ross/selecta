// A white-label sleeve: the title typeset on a dark square with a thin label
// ring. The ring's size, grooves and index mark come from the track ID, so a
// record looks the same every time and never like art. Album art covers it once
// loaded, and the label stays underneath for tracks with none.
import { memo, useState } from 'react';
import { useArtwork } from '../artwork.js';

/** FNV-1a: small, stable, and enough to vary three details. */
function hash(text: string): number {
  let h = 0x811c9dc5;

  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);

  return h >>> 0;
}

export const Sleeve = memo(function Sleeve({
  trackId,
  title,
}: {
  trackId: string;
  title?: string;
}) {
  const art = useArtwork(trackId);
  const [loaded, setLoaded] = useState<string>();
  const h = hash(trackId);
  const ring = 15 + (h % 7);
  const grooves = 2 + ((h >>> 4) % 3);
  const angle = (h >>> 8) % 360;

  return (
    <div className="sleeve">
      <svg className="sleeve-ring" viewBox="0 0 100 100" aria-hidden="true">
        {Array.from({ length: grooves }, (_, i) => (
          <circle key={i} className="groove" cx="50" cy="62" r={ring + 6 + i * 4} />
        ))}
        <circle className="label" cx="50" cy="62" r={ring} />
        <circle className="hole" cx="50" cy="62" r="1.6" />
        <line
          className="index"
          x1="50"
          y1={62 - ring + 2}
          x2="50"
          y2={62 - ring + 6}
          transform={`rotate(${angle} 50 62)`}
        />
      </svg>
      <span className="sleeve-title">{title ?? 'Untitled'}</span>
      {art && (
        <img
          className={loaded === art ? 'sleeve-art shown' : 'sleeve-art'}
          src={art}
          alt=""
          draggable={false}
          onLoad={() => setLoaded(art)}
        />
      )}
    </div>
  );
});
