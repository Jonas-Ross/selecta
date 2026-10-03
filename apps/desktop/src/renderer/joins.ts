// What sits between two neighbouring records: the tempo step and where their
// keys sit on the wheel. Geometry in plain words, never a verdict.
import { harmonicRelation, type HarmonicRelation } from '@selecta/core/domain/harmonic.js';
import type { Track } from './state.js';

export const RELATION_WORDS: Record<HarmonicRelation, string> = {
  same: 'Same key',
  adjacent: 'Next door on the key wheel',
  relative: 'Same notes, other mood',
  energy_boost: 'Two steps up the wheel',
  distant: 'Far apart on the key wheel',
  unknown: 'Key unknown',
};

/** Tempos as the lanes print them: whole BPM. */
const roundBpm = (bpm: number) => Math.round(bpm);

export function tempoStep(from?: number, to?: number): string {
  if (from === undefined || to === undefined) return 'Tempo not measured';

  const delta = roundBpm(to) - roundBpm(from);

  if (delta === 0) return 'Same tempo';

  // A real minus sign, so the column of deltas lines up.
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta)} BPM`;
}

export type Join = {
  tempo: string;
  relation: HarmonicRelation;
  words: string;
  from?: string;
  to?: string;
  provisional: boolean; // rests on a key reading still being checked
};

export function join(a: Track, b: Track): Join {
  const relation = harmonicRelation(a.camelot, b.camelot);

  return {
    tempo: tempoStep(a.bpm, b.bpm),
    relation,
    words: RELATION_WORDS[relation],
    from: a.camelot,
    to: b.camelot,
    provisional:
      relation !== 'unknown' &&
      (a.key_maturity === 'provisional' || b.key_maturity === 'provisional'),
  };
}
