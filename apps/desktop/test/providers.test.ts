import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderStatus } from '../src/shared/protocol.js';
import {
  canSwap,
  pickProvider,
  rememberProvider,
  rememberedProvider,
} from '../src/renderer/providers.js';

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

it('offers a swap with two agents ready, or when the draft is stuck on one that cannot run', () => {
  const claude = { id: 'claude', label: 'Claude', ready: true } as const;
  const codex = { id: 'codex', label: 'Codex', ready: true } as const;
  const signedOut = { ...claude, ready: false };

  expect(canSwap([claude, codex], 'claude')).toBe(true);
  expect(canSwap([claude, { ...codex, ready: false }], 'claude')).toBe(false);
  expect(canSwap([signedOut, codex], 'claude')).toBe(true);
  expect(canSwap([signedOut, codex], 'codex')).toBe(false);
  expect(canSwap([signedOut, { ...codex, ready: false }], 'claude')).toBe(false);
  expect(canSwap(undefined, 'claude')).toBe(false);
});
