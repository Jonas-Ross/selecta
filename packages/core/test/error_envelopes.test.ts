import { expect, it } from 'vitest';
import { BridgeError, defaultHints, toErrorEnvelope } from '../src/types/errors.js';
import { toErrorEnvelope as toolErrorEnvelope } from '../src/tools/errors.js';

it('preserves a custom error hint and exact partial receipt through both boundaries', () => {
  const error = new BridgeError('jxa_error', 'readback failed', 'Inspect this target', {
    playlist_id: 'P',
    observed_track_ids: ['B', 'A', 'B'],
  });
  const expected = {
    error: 'jxa_error',
    hint: 'Inspect this target',
    partial_write: { playlist_id: 'P', observed_track_ids: ['B', 'A', 'B'] },
  };

  expect(toErrorEnvelope(error)).toEqual(expected);
  expect(toolErrorEnvelope(error)).toEqual(expected);
});

it('resolves the canonical hint without treating known errors as fallback failures', () => {
  expect(
    toErrorEnvelope(new BridgeError('music_app_not_running', 'stopped'), {
      error: 'cache_unavailable',
      hint: 'creation fallback',
    }),
  ).toEqual({ error: 'music_app_not_running', hint: defaultHints.music_app_not_running });
});

it('rethrows unknown errors unless the operation explicitly supplies a fallback', () => {
  const error = new Error('disk full');

  expect(() => toolErrorEnvelope(error)).toThrow(error);
  expect(() => toErrorEnvelope(error)).toThrow(error);
  expect(
    toErrorEnvelope(error, { error: 'cache_unavailable', hint: 'Could not persist.' }),
  ).toEqual({
    error: 'cache_unavailable',
    hint: 'Could not persist. Error: disk full',
  });
});
