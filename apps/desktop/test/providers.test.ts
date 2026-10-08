import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderStatus } from '../src/shared/protocol.js';
import { pickProvider, rememberProvider, rememberedProvider } from '../src/renderer/providers.js';

afterEach(() => vi.unstubAllGlobals());

const claude: ProviderStatus = { id: 'claude', label: 'Claude', ready: true };
const codex: ProviderStatus = { id: 'codex', label: 'Codex', ready: true };
const found = [claude, codex];

it('offers the agent picked last while it can still run, else the first that can', () => {
  const store = new Map<string, string>();

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });

  expect(pickProvider(found)).toBe('claude');
  rememberProvider('codex');
  expect(pickProvider(found)).toBe('codex');
  expect(pickProvider([claude, { ...codex, ready: false }])).toBe('claude');
  expect(pickProvider(found.map((option) => ({ ...option, ready: false })))).toBeUndefined();
  store.set('selecta.agent', 'gemini');
  expect(rememberedProvider()).toBeUndefined();
});

it('treats storage that throws as nothing remembered', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  });

  expect(() => rememberProvider('codex')).not.toThrow();
  expect(pickProvider(found)).toBe('claude');
});
