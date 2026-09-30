// Camelot relations, checked against the wheel a DJ would read off a chart
// rather than against the formula that produced them.

import { describe, expect, it } from 'vitest';
import { harmonicRelation, parseCamelot } from '../src/domain/harmonic.js';

describe('parseCamelot', () => {
  it('accepts every position on the wheel and nothing else', () => {
    for (let number = 1; number <= 12; number += 1) {
      for (const mode of ['A', 'B'] as const) {
        expect(parseCamelot(`${number}${mode}`)).toEqual({ number, mode });
      }
    }

    expect(parseCamelot(' 11a ')).toEqual({ number: 11, mode: 'A' });

    for (const bad of [null, undefined, '', '0A', '13A', '11C', '11', 'A11', 'F# minor']) {
      expect(parseCamelot(bad)).toBeNull();
    }
  });
});

describe('harmonicRelation', () => {
  it('names the four moves the wheel is drawn for', () => {
    expect(harmonicRelation('8A', '8A')).toBe('same');
    expect(harmonicRelation('8A', '9A')).toBe('adjacent');
    expect(harmonicRelation('8A', '7A')).toBe('adjacent');
    expect(harmonicRelation('8A', '8B')).toBe('relative');
    expect(harmonicRelation('8B', '8A')).toBe('relative');
    expect(harmonicRelation('8A', '10A')).toBe('energy_boost');
  });

  it('wraps round 12 rather than running off the end', () => {
    expect(harmonicRelation('12A', '1A')).toBe('adjacent');
    expect(harmonicRelation('1A', '12A')).toBe('adjacent');
    expect(harmonicRelation('12B', '2B')).toBe('energy_boost');
    expect(harmonicRelation('11A', '1A')).toBe('energy_boost');
  });

  it('is directional: the lift up the wheel has no counterpart down it', () => {
    expect(harmonicRelation('10A', '8A')).toBe('distant');
    expect(harmonicRelation('1A', '11A')).toBe('distant');
  });

  it('calls anything further apart, or across modes, distant', () => {
    expect(harmonicRelation('8A', '11A')).toBe('distant');
    expect(harmonicRelation('8A', '2A')).toBe('distant');
    expect(harmonicRelation('8A', '9B')).toBe('distant');
    expect(harmonicRelation('8A', '7B')).toBe('distant');
  });

  it('reports unknown rather than guessing when a position is missing', () => {
    expect(harmonicRelation(null, '8A')).toBe('unknown');
    expect(harmonicRelation('8A', undefined)).toBe('unknown');
    expect(harmonicRelation('F# minor', '8A')).toBe('unknown');
    expect(harmonicRelation(null, null)).toBe('unknown');
  });
});
