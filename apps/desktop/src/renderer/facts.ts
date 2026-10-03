// Where a tempo or key came from and how far to trust it, in words a
// non-musician can read. Absent provenance stays "not recorded", never guessed.
import type { Track } from './state.js';

export function sourceText(source?: string): string {
  if (source === undefined) return 'Not recorded';

  if (source.startsWith('metrognome')) return 'Measured on this Mac from a 30 s preview';

  if (source === 'acousticbrainz') return 'From the AcousticBrainz catalog';

  if (source === 'deezer') return 'From the Deezer catalog';

  if (source === 'music_app') return 'A tag set in Music.app';

  return source;
}

/** The same, short enough for one line beside the value. */
export function sourceShort(source?: string): string {
  if (source === undefined) return 'Source not recorded';

  if (source.startsWith('metrognome')) return 'Measured here';

  return (
    { acousticbrainz: 'AcousticBrainz', deezer: 'Deezer', music_app: 'Music.app tag' }[source] ??
    source
  );
}

const MATURITY = {
  validated: 'Validated: the method was checked against real tracks',
  provisional: 'Provisional: a first reading, still being checked',
};

export type Fact = { label: string; text: string };

export function tempoFacts(track: Track): Fact[] {
  return [
    { label: 'source', text: sourceText(track.bpm_source) },
    {
      label: 'confidence',
      text:
        track.bpm_confidence === undefined
          ? 'None given'
          : `${track.bpm_confidence.toFixed(2)} of 1`,
    },
    ...(track.bpm_maturity ? [{ label: 'status', text: MATURITY[track.bpm_maturity] }] : []),
    // The analyzer can't tell a tempo from its half, so slow music may read double.
    ...(track.bpm_half_time !== undefined
      ? [{ label: 'or', text: `${Math.round(track.bpm_half_time)} BPM, if it is half time` }]
      : []),
  ];
}

export function keyFacts(track: Track): Fact[] {
  return [
    { label: 'source', text: sourceText(track.key_source) },
    {
      label: 'confidence',
      text:
        track.key_confidence === undefined
          ? 'None given'
          : `${track.key_confidence.toFixed(2)} of 1`,
    },
    ...(track.key_maturity ? [{ label: 'status', text: MATURITY[track.key_maturity] }] : []),
  ];
}
