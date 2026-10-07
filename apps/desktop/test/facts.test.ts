import { expect, it } from 'vitest';
import { keyFacts, sourceShort, sourceText, tempoFacts } from '../src/renderer/facts.js';

it('says where a value came from in plain words', () => {
  expect(sourceText('metrognome/kick@3')).toBe('Measured on this Mac from a 30 s preview');
  expect(sourceText('acousticbrainz')).toBe('From the AcousticBrainz catalog');
  expect(sourceText('deezer')).toBe('From the Deezer catalog');
  expect(sourceText('music_app')).toBe('A tag set in Music.app');
  expect(sourceText(undefined)).toBe('Not recorded');
});

it('lists confidence, status and the half-time reading only when known', () => {
  expect(
    tempoFacts({
      bpm: 140,
      bpm_source: 'metrognome/kick@3',
      bpm_confidence: 0.912,
      bpm_maturity: 'validated',
      bpm_half_time: 70,
    }).map((fact) => fact.label),
  ).toEqual(['source', 'confidence', 'status', 'or']);
  expect(tempoFacts({ bpm: 120, bpm_source: 'deezer' })[1]!.text).toBe('None given');
  expect(keyFacts({ key_confidence: 0.6, key_maturity: 'provisional' })).toEqual([
    { label: 'source', text: 'Not recorded' },
    { label: 'confidence', text: '0.60 of 1' },
    { label: 'status', text: 'Still being tested, so treat it as a hint' },
  ]);
});

it('says where a value came from in a few words beside it', () => {
  expect(sourceShort('metrognome/kick@4')).toBe('Measured here');
  expect(sourceShort('deezer')).toBe('Deezer');
  expect(sourceShort('music_app')).toBe('Music.app tag');
  expect(sourceShort(undefined)).toBe('Source not recorded');
  expect(sourceShort('somewhere')).toBe('somewhere');
});
