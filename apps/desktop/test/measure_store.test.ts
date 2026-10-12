import { expect, it, vi } from 'vitest';
import { createMeasureStore } from '../src/renderer/hooks/useMeasure.js';
import type { SelectaApi } from '../src/shared/protocol.js';

// The module-level store reads window.selecta, which a node test has none of.
vi.mock('../src/renderer/api.js', () => ({ selecta: { call: vi.fn() } }));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

it('asks once why the blanks on screen are blank, then lets a measurement take over', async () => {
  const call = vi.fn(async (method: string) =>
    method === 'features.heard' ? { A: { key: 'unsure' } } : { key: 'no_reading' },
  );
  const store = createMeasureStore(call as unknown as SelectaApi['call']);

  store.subscribe('A', () => {});
  store.subscribe('B', () => {});
  store.subscribe('A', () => {});
  await tick();

  expect(call.mock.calls).toEqual([['features.heard', { track_ids: ['A', 'B'] }]]);
  expect(store.state('A')).toEqual({ phase: 'heard', result: { key: 'unsure' } });
  // Never tried, so it keeps the measure button.
  expect(store.state('B')).toBeUndefined();

  store.measure('B');
  expect(store.state('B')).toEqual({ phase: 'measuring' });
  await tick();
  expect(store.state('B')).toEqual({ phase: 'done', result: { key: 'no_reading' } });
});

it('leaves the measure button when the lookup fails', async () => {
  const store = createMeasureStore(async () => {
    throw new Error('host gone');
  });

  store.subscribe('A', () => {});
  await tick();

  expect(store.state('A')).toBeUndefined();
});
