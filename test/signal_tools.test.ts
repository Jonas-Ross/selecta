// Track-signal write tools (set_loved / set_rating): bridge mocked, cache
// real (in-memory, production write path). Asserts the surgical cache patch
// from the bridge's post-write readback and the no-write-on-bad-input
// guarantees.

import { describe, it, expect, vi } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';
import { handleSetLoved, type SetLovedOutput } from '../src/tools/set_loved.js';
import { handleSetRating, type SetRatingOutput } from '../src/tools/set_rating.js';
import type { ToolDeps } from '../src/tools/common.js';
import type { Bridge, LibrarySnapshot, TrackSignalState } from '../src/types/bridge.js';
import { BridgeError } from '../src/types/errors.js';
import { asError, makeBridge } from './helpers.js';
import fixture from './fixtures/library.json' with { type: 'json' };

const snapshot = fixture as LibrarySnapshot;

// Fixture signal baselines: T-TEARDROP loved, rating 100; T-ANGEL neither.

function makeDeps(
  bridgeOverrides: Partial<Bridge> = {},
): ToolDeps & { cacheInstance: SelectaCache } {
  const cache = SelectaCache.open(':memory:');
  cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
  return { cache: () => cache, bridge: makeBridge(bridgeOverrides), cacheInstance: cache };
}

function signalResult(tracks: TrackSignalState[], preWriteTracks: TrackSignalState[] = tracks) {
  return { tracks, preWriteTracks };
}

function signalRow(cache: SelectaCache, id: string): { loved: 0 | 1; rating: number | null } {
  const row = cache.getTrack(id);
  expect(row).not.toBeNull();
  return { loved: row!.loved, rating: row!.rating };
}

describe('set_loved', () => {
  it('loves via the bridge and patches the cache from the readback', async () => {
    const deps = makeDeps({
      setTrackLoved: vi.fn().mockResolvedValue(
        signalResult(
          [
            { persistentId: 'T-ANGEL', loved: true, rating: 0 },
            { persistentId: 'T-ROADS', loved: true, rating: 0 },
          ],
          [
            { persistentId: 'T-ANGEL', loved: false, rating: 0 },
            { persistentId: 'T-ROADS', loved: false, rating: 0 },
          ],
        ),
      ),
    });
    const out = (await handleSetLoved(
      { track_ids: ['T-ANGEL', 'T-ROADS'], loved: true },
      deps,
    )) as SetLovedOutput;

    expect(out).toEqual({ updated: 2, loved: true });
    expect(deps.bridge.setTrackLoved).toHaveBeenCalledWith({
      trackIds: ['T-ANGEL', 'T-ROADS'],
      loved: true,
    });
    expect(signalRow(deps.cacheInstance, 'T-ANGEL').loved).toBe(1);
    expect(signalRow(deps.cacheInstance, 'T-ROADS').loved).toBe(1);
    expect(deps.bridge.readLibrary).not.toHaveBeenCalled();
  });

  it('unloves and clears the cached flag', async () => {
    const deps = makeDeps({
      setTrackLoved: vi
        .fn()
        .mockResolvedValue(
          signalResult([{ persistentId: 'T-TEARDROP', loved: false, rating: 100 }]),
        ),
    });
    const out = (await handleSetLoved(
      { track_ids: ['T-TEARDROP'], loved: false },
      deps,
    )) as SetLovedOutput;

    expect(out).toEqual({ updated: 1, loved: false });
    // The rating carried in the readback is preserved, not clobbered.
    expect(signalRow(deps.cacheInstance, 'T-TEARDROP')).toEqual({ loved: 0, rating: 100 });
  });

  it('stores the readback as ground truth even when it disagrees with the request', async () => {
    // A settling sync could report different values than we wrote; the cache
    // must reflect what Music.app SAYS, not what we asked for.
    const deps = makeDeps({
      setTrackLoved: vi
        .fn()
        .mockResolvedValue(signalResult([{ persistentId: 'T-ANGEL', loved: false, rating: 60 }])),
    });
    await handleSetLoved({ track_ids: ['T-ANGEL'], loved: true }, deps);
    expect(signalRow(deps.cacheInstance, 'T-ANGEL')).toEqual({ loved: 0, rating: 60 });
  });

  it('rejects unknown track IDs before any bridge call', async () => {
    const deps = makeDeps();
    const err = asError(await handleSetLoved({ track_ids: ['T-FAKE'], loved: true }, deps));
    expect(err.error).toBe('track_not_found');
    expect(err.hint).toContain('T-FAKE');
    expect(deps.bridge.setTrackLoved).not.toHaveBeenCalled();
  });

  it('propagates a bridge failure without patching the cache', async () => {
    const deps = makeDeps({
      setTrackLoved: vi
        .fn()
        .mockRejectedValue(new BridgeError('track_not_found', 'gone live', 'stale')),
    });
    const err = asError(await handleSetLoved({ track_ids: ['T-ANGEL'], loved: true }, deps));
    expect(err.error).toBe('track_not_found');
    expect(signalRow(deps.cacheInstance, 'T-ANGEL').loved).toBe(0);
  });

  it('rejects an empty track_ids array', async () => {
    const deps = makeDeps();
    const err = asError(await handleSetLoved({ track_ids: [], loved: true }, deps));
    expect(err.error).toBe('validation_error');
    expect(deps.bridge.setTrackLoved).not.toHaveBeenCalled();
  });
});

describe('set_rating', () => {
  it('converts stars to the 0–100 scale and patches the cache from the readback', async () => {
    const deps = makeDeps({
      setTrackRating: vi
        .fn()
        .mockResolvedValue(signalResult([{ persistentId: 'T-ANGEL', loved: false, rating: 90 }])),
    });
    const out = (await handleSetRating(
      { track_ids: ['T-ANGEL'], rating: 4.5 },
      deps,
    )) as SetRatingOutput;

    expect(out).toEqual({ updated: 1, rating: 4.5 });
    expect(deps.bridge.setTrackRating).toHaveBeenCalledWith({
      trackIds: ['T-ANGEL'],
      rating: 90,
    });
    expect(signalRow(deps.cacheInstance, 'T-ANGEL')).toEqual({ loved: 0, rating: 90 });
  });

  it('rating 0 clears: the cache stores NULL, matching what a refresh writes', async () => {
    const deps = makeDeps({
      setTrackRating: vi
        .fn()
        .mockResolvedValue(signalResult([{ persistentId: 'T-TEARDROP', loved: true, rating: 0 }])),
    });
    const out = (await handleSetRating(
      { track_ids: ['T-TEARDROP'], rating: 0 },
      deps,
    )) as SetRatingOutput;

    expect(out).toEqual({ updated: 1, rating: 0 });
    expect(deps.bridge.setTrackRating).toHaveBeenCalledWith({
      trackIds: ['T-TEARDROP'],
      rating: 0,
    });
    expect(signalRow(deps.cacheInstance, 'T-TEARDROP')).toEqual({ loved: 1, rating: null });
  });

  it('rejects a non-half-star rating', async () => {
    const deps = makeDeps();
    const err = asError(await handleSetRating({ track_ids: ['T-ANGEL'], rating: 3.7 }, deps));
    expect(err.error).toBe('validation_error');
    expect(deps.bridge.setTrackRating).not.toHaveBeenCalled();
  });

  it('rejects a rating above 5', async () => {
    const deps = makeDeps();
    const err = asError(await handleSetRating({ track_ids: ['T-ANGEL'], rating: 6 }, deps));
    expect(err.error).toBe('validation_error');
    expect(deps.bridge.setTrackRating).not.toHaveBeenCalled();
  });

  it('rejects unknown track IDs before any bridge call', async () => {
    const deps = makeDeps();
    const err = asError(await handleSetRating({ track_ids: ['T-FAKE'], rating: 5 }, deps));
    expect(err.error).toBe('track_not_found');
    expect(deps.bridge.setTrackRating).not.toHaveBeenCalled();
  });

  it('propagates a bridge failure without patching the cache', async () => {
    const deps = makeDeps({
      setTrackRating: vi.fn().mockRejectedValue(new BridgeError('jxa_error', 'boom')),
    });
    const err = asError(await handleSetRating({ track_ids: ['T-MIDNIGHT'], rating: 1 }, deps));
    expect(err.error).toBe('jxa_error');
    expect(signalRow(deps.cacheInstance, 'T-MIDNIGHT').rating).toBe(80);
  });
});
