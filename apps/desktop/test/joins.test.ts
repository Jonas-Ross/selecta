import { expect, it } from 'vitest';
import { join, RELATION_WORDS, tempoStep } from '../src/renderer/joins.js';

it('words the tempo step in whole BPM', () => {
  expect(tempoStep(120, 122.4)).toBe('+2 BPM');
  expect(tempoStep(124, 121)).toBe('−3 BPM');
  expect(tempoStep(120.2, 119.8)).toBe('Same tempo');
  expect(tempoStep(undefined, 120)).toBe('Tempo not measured');
});

it('names each wheel relation in plain words', () => {
  expect(join({ camelot: '8A' }, { camelot: '8A' }).words).toBe('Same key');
  expect(join({ camelot: '8A' }, { camelot: '9A' }).words).toBe('Next door on the key wheel');
  expect(join({ camelot: '8A' }, { camelot: '8B' }).words).toBe('Same notes, other mood');
  expect(join({ camelot: '8A' }, { camelot: '10A' }).words).toBe('Two steps up the wheel');
  expect(join({ camelot: '8A' }, { camelot: '3B' }).words).toBe('Far apart on the key wheel');
  expect(join({ camelot: '8A' }, {}).words).toBe('Key unknown');
  expect(Object.keys(RELATION_WORDS)).toHaveLength(6);
});

it('flags a join resting on a provisional key, but not an unknown one', () => {
  expect(join({ camelot: '8A', key_maturity: 'provisional' }, { camelot: '9A' }).provisional).toBe(
    true,
  );
  expect(join({ camelot: '8A', key_maturity: 'provisional' }, {}).provisional).toBe(false);
  expect(join({ camelot: '8A' }, { camelot: '9A' }).provisional).toBe(false);
});
