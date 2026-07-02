// Shared test scaffolding. The all-rejecting Bridge mock lives here once —
// adding a Bridge method means one edit in this file, not one per test file
// (adding the #15 edit methods touched four copies before this existed).

import { expect, vi } from 'vitest';
import type { Bridge } from '../src/types/bridge.js';
import type { SelectaError } from '../src/types/errors.js';

export function makeBridge(overrides: Partial<Bridge> = {}): Bridge {
  return {
    readPlaylist: vi.fn().mockRejectedValue(new Error('not used')),
    readLibrary: vi.fn().mockRejectedValue(new Error('not used')),
    createPlaylist: vi.fn().mockRejectedValue(new Error('not used')),
    replacePlaylist: vi.fn().mockRejectedValue(new Error('not used')),
    deletePlaylistById: vi.fn().mockRejectedValue(new Error('not used')),
    addPlaylistTracks: vi.fn().mockRejectedValue(new Error('not used')),
    removePlaylistTracks: vi.fn().mockRejectedValue(new Error('not used')),
    ...overrides,
  };
}

export function asError(result: object): SelectaError {
  expect(result).toHaveProperty('error');
  return result as SelectaError;
}
