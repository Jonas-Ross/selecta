import { afterEach, expect, it, vi } from 'vitest';
import {
  DEFAULTS,
  clampLead,
  loadSettings,
  parseSettings,
  storeSettings,
} from '../src/renderer/settings.js';

afterEach(() => vi.unstubAllGlobals());

it('keeps the join lead on the slider’s steps and inside its range', () => {
  expect(clampLead(60)).toBe(60);
  expect(clampLead(42)).toBe(40);
  expect(clampLead(3)).toBe(15);
  expect(clampLead(900)).toBe(120);
  expect(clampLead(Number.NaN)).toBe(60);
});

it('falls back to the default for anything it can’t read', () => {
  expect(parseSettings(undefined)).toEqual(DEFAULTS);
  expect(parseSettings('nope')).toEqual(DEFAULTS);
  expect(parseSettings({ joinLead: '30', crateOrder: 'best', motion: 'wild' })).toEqual(DEFAULTS);
  expect(parseSettings({ joinLead: 33, crateOrder: 'most_played', motion: 'reduce' })).toEqual({
    joinLead: 35,
    crateOrder: 'most_played',
    motion: 'reduce',
  });
});

it('round-trips through storage, and survives storage that is broken or throws', () => {
  const store = new Map<string, string>();

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });

  expect(loadSettings()).toEqual(DEFAULTS);
  storeSettings({ joinLead: 30, crateOrder: 'random', motion: 'system' });
  expect(loadSettings()).toEqual({ joinLead: 30, crateOrder: 'random', motion: 'system' });
  store.set('selecta.settings', '{not json');
  expect(loadSettings()).toEqual(DEFAULTS);

  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  });

  expect(loadSettings()).toEqual(DEFAULTS);
  expect(() => storeSettings(DEFAULTS)).not.toThrow();
});
