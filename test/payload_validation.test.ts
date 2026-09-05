import { describe, it, expect, vi, afterEach } from 'vitest';
import { bridge } from '../src/bridge/index.js';
import { runJxa } from '../src/bridge/jxa.js';
import { SelectaCache } from '../src/cache/index.js';
import { enrichPendingTracks } from '../src/enrich/engine.js';
import fixture from './fixtures/library.json' with { type: 'json' };
vi.mock('../src/bridge/jxa.js', () => ({ runJxa: vi.fn() }));
afterEach(() => vi.clearAllMocks());

describe('external payload boundaries', () => {
  it.each([
    { playCount: '42' },
    { loved: 1 },
    { rating: 101 },
    { locationKind: 'stream' },
    { dateAdded: 'yesterday' },
    { durationSeconds: -1 },
  ])('rejects malformed optional track fields: %j', async (fields) => {
    vi.mocked(runJxa).mockResolvedValue({ ...fixture, tracks: [{ persistentId: 'A', ...fields }] });
    await expect(bridge.readLibrary()).rejects.toMatchObject({
      errorCode: 'jxa_error',
      message: expect.stringContaining('tracks.0.'),
    });
  });
  it('rejects unknown playlist kinds', async () => {
    vi.mocked(runJxa).mockResolvedValue({
      persistentId: 'P',
      name: 'Mix',
      kind: 'unknown',
      trackPersistentIds: [],
    });
    await expect(bridge.readPlaylist('P')).rejects.toMatchObject({ errorCode: 'jxa_error' });
  });
  it.each([
    { missingTrackIds: [123] },
    { invalidPositions: [-1], liveTrackCount: 2 },
    { persistentId: 'P', trackCount: 3, trackPersistentIds: ['A'], preEditTrackPersistentIds: [] },
  ])('rejects malformed edit results: %j', async (result) => {
    vi.mocked(runJxa).mockResolvedValue(result);
    await expect(
      bridge.removePlaylistTracks({ playlistId: 'P', positions: [0] }),
    ).rejects.toMatchObject({ errorCode: 'jxa_error' });
  });
  it.each([
    null,
    {},
    { recordings: 'nope' },
    { recordings: [{ score: 100 }] },
    { recordings: [{ id: 'mb', score: '100' }] },
  ])('keeps malformed MusicBrainz targets pending: %j', async (body) => {
    const cache = SelectaCache.open(':memory:');
    try {
      cache.refreshFromSnapshot(fixture, { durationMs: 1 });
      const fetchLike = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
      const result = await enrichPendingTracks(
        cache,
        { trackIds: ['T-TEARDROP'] },
        { fetchLike, sleep: async () => {} },
      );
      expect(result.skipped).toBe(1);
      expect(result.errors[0]).toContain('MusicBrainz');
      expect(cache.getAudioFeatures('T-TEARDROP')).toBeNull();
      expect(fetchLike).toHaveBeenCalledTimes(1);
    } finally {
      cache.close();
    }
  });
  it.each(['deezer-id', 'deezer-bpm', 'acousticbrainz'])(
    'does not persist invalid %s payloads',
    async (scenario) => {
      const cache = SelectaCache.open(':memory:');
      try {
        cache.refreshFromSnapshot(fixture, { durationMs: 1 });
        const urls: string[] = [];
        const result = await enrichPendingTracks(
          cache,
          { trackIds: ['T-TEARDROP'] },
          {
            sleep: async () => {},
            fetchLike: async (url) => {
              urls.push(url);
              const body = url.includes('musicbrainz.org')
                ? { recordings: scenario === 'acousticbrainz' ? [{ id: 'mb', score: 100 }] : [] }
                : url.includes('acousticbrainz.org')
                  ? null
                  : url.includes('/search?')
                    ? {
                        data: [
                          scenario === 'deezer-id' ? { duration: 331 } : { id: 1, duration: 331 },
                        ],
                      }
                    : { bpm: 'fast' };
              return { ok: true, status: 200, json: async () => body };
            },
          },
        );
        expect(result.skipped).toBe(1);
        expect(cache.getAudioFeatures('T-TEARDROP')).toBeNull();
        expect(urls.some((url) => url.includes('undefined'))).toBe(false);
      } finally {
        cache.close();
      }
    },
  );
});
