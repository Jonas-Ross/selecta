import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { featuresRow, makeToolDeps } from '../../../packages/core/test/helpers.js';
import { DraftStore } from '@selecta/core/drafts/store.js';
import { withOperation } from '@selecta/core/operations/lock.js';
import { createApi } from '../src/host/api.js';
import type { AgentSessions } from '../src/host/agent.js';
import {
  abortableSleep,
  createMeasurer,
  SEARCH_SPACING_MS,
  trackedSpawn,
  verdict,
} from '../src/host/measure.js';

const recorded = readFileSync(
  new URL('../../../packages/core/test/fixtures/metrognome.jsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n');

/** A clock that only moves when the measurer sleeps. */
function clock() {
  let t = 0;
  const waits: number[] = [];

  return {
    waits,
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
  };
}

it('joins a second request for the same track and batches the ones that queue meanwhile', async () => {
  const runs: string[][] = [];
  let finish!: () => void;
  const time = clock();
  const measurer = createMeasurer({
    run: (ids) => {
      runs.push(ids);

      return runs.length === 1
        ? new Promise(
            (resolve) => (finish = () => resolve({ skipped: [], errors: [], started: true })),
          )
        : Promise.resolve({ skipped: [], errors: [], started: true });
    },
    features: (id) => featuresRow({ trackPersistentId: id, analysisStatus: 'ok' }),
    ...time,
  });

  const first = measurer.measure('A');

  expect(measurer.measure('A')).toBe(first);
  await Promise.resolve();

  const queued = [measurer.measure('B'), measurer.measure('C'), measurer.measure('B')];

  finish();
  await Promise.all([first, ...queued]);

  expect(runs).toEqual([['A'], ['B', 'C']]);
  // The second run waits out the first's share of the store's search budget.
  expect(time.waits).toEqual([0, SEARCH_SPACING_MS]);
});

it('says why each blank feature is still blank', () => {
  const row = (over: Parameters<typeof featuresRow>[0]) => featuresRow({ ...over });

  expect(verdict(row({ analysisStatus: 'ok' }))).toEqual({});
  expect(verdict(row({ musicalKey: null, analysisStatus: 'ok' }))).toEqual({ key: 'unsure' });
  expect(verdict(row({ bpm: null, musicalKey: null, analysisStatus: 'no_data' }))).toEqual({
    tempo: 'no_reading',
    key: 'no_reading',
  });
  expect(verdict(row({ bpm: null, analysisStatus: 'no_match' }))).toEqual({ tempo: 'not_found' });
  expect(verdict(undefined, 'metrognome was not found')).toEqual({
    tempo: 'failed',
    key: 'failed',
    error: 'metrognome was not found',
  });
});

it('charges the search budget only when metrognome ran', async () => {
  const time = clock();
  let runs = 0;
  const measurer = createMeasurer({
    // The first run can't start metrognome; the second does, and its search fails after.
    run: async (ids) => ({ skipped: ids, errors: ['metrognome failed'], started: runs++ > 0 }),
    features: () => undefined,
    ...time,
  });

  await Promise.all([measurer.measure('A'), measurer.measure('B')]);
  await Promise.all([measurer.measure('A'), measurer.measure('B')]);
  await measurer.measure('A');

  expect(time.waits).toEqual([0, 0, 2 * SEARCH_SPACING_MS]);
});

it('hands a run failure to every waiting request', async () => {
  const measurer = createMeasurer({
    run: () => Promise.reject(new Error('Another enrich operation is active')),
    features: () => undefined,
    ...clock(),
  });

  await expect(measurer.measure('A')).rejects.toThrow('Another enrich operation');
  // A failed run leaves nothing behind, so asking again tries again.
  await expect(measurer.measure('A')).rejects.toThrow('Another enrich operation');
});

function apiWith(metrognome: object) {
  const base = makeToolDeps();
  const store = new DraftStore(base.drafts!().path);
  const deps = { ...base, drafts: () => store, enrich: { metrognome } };
  const artwork = { get: vi.fn() };

  return {
    cache: base.cacheInstance,
    call: createApi(deps, {} as AgentSessions, artwork, async () => []),
  };
}

const installed = { binaryPath: 'metrognome', readVersion: async () => 'metrognome 0.3.0\n' };

it('measures a track metrognome never tried, and stores what it hears', async () => {
  // Echoes the recorded M83 result for whichever track is asked about.
  const answer = recorded.find((l) => l.includes('"client_ref":"T-MIDNIGHT"'))!;
  const script = `require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
    const ref = JSON.parse(l).client_ref;
    console.log(${JSON.stringify(answer)}.replace('"T-MIDNIGHT"', JSON.stringify(ref)));
  });`;
  const { cache, call } = apiWith({
    ...installed,
    spawnLike: () => spawn(process.execPath, ['-e', script]),
  });

  cache.saveAudioFeatures([
    featuresRow({
      trackPersistentId: 'T-ROADS',
      bpm: null,
      musicalKey: null,
      camelot: null,
      sources: null,
      status: 'no_data',
      catalogStatus: 'no_data',
      analysisStatus: null,
    }),
  ]);

  expect(await call('features.heard', { track_ids: ['T-ROADS'] })).toEqual({});
  expect(await call('features.measure', { track_id: 'T-ROADS' })).toEqual({});
  expect(cache.getAudioFeatures('T-ROADS')).toMatchObject({
    camelot: '8A',
    keyMaturity: 'provisional',
    analysisStatus: 'ok',
  });
  expect(cache.getAudioFeatures('T-ROADS')!.sources).toMatchObject({
    bpm: 'metrognome/onset-autocorrelation-comb@1',
  });
});

it('says why up front where metrognome already listened, and never listens again', async () => {
  const spawnLike = vi.fn(() => {
    throw new Error('should not run');
  });
  const { cache, call } = apiWith({ ...installed, spawnLike });

  cache.saveAudioFeatures([
    featuresRow({
      trackPersistentId: 'T-ROADS',
      musicalKey: null,
      camelot: null,
      catalogStatus: null,
      analysisStatus: 'ok',
    }),
  ]);

  expect(await call('features.heard', { track_ids: ['T-ROADS', 'T-MIDNIGHT'] })).toEqual({
    'T-ROADS': { key: 'unsure' },
  });
  expect(await call('features.measure', { track_id: 'T-ROADS' })).toEqual({ key: 'unsure' });
  expect(spawnLike).not.toHaveBeenCalled();
});

it('says plainly when metrognome cannot run', async () => {
  const { call } = apiWith({
    ...installed,
    spawnLike: () => {
      throw new Error('spawn metrognome ENOENT');
    },
  });

  expect(await call('features.measure', { track_id: 'T-ROADS' })).toMatchObject({
    tempo: 'failed',
    key: 'failed',
    error: expect.stringContaining('ENOENT'),
  });
  await expect(call('features.measure', { track_id: '' })).rejects.toThrow();
});

it('says so in plain words when another run holds the cache', async () => {
  const { cache, call } = apiWith(installed);

  await withOperation(cache, 'enrich', () =>
    expect(call('features.measure', { track_id: 'T-ROADS' })).rejects.toThrow(
      'Another measuring run is going',
    ),
  );
});

it('stops a metrognome still running when the app quits', async () => {
  const tracked = trackedSpawn();
  const child = tracked.spawnLike(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)']);
  const closed = new Promise((resolve) => child.on('close', (_code, signal) => resolve(signal)));

  tracked.killAll();
  expect(await closed).toBe('SIGTERM');
  expect(() => tracked.spawnLike(process.execPath, ['-e', ''])).toThrow('The app is closing');
});

it('drops measurements still waiting their turn when the app quits', async () => {
  const runs: string[][] = [];
  const measurer = createMeasurer({
    run: async (ids) => {
      runs.push(ids);

      return { skipped: [], errors: [], started: true };
    },
    features: () => undefined,
  });

  await measurer.measure('A');

  // The next run waits out A's share of the search budget on a real timer.
  const waiting = measurer.measure('B');

  measurer.stop();
  await expect(waiting).rejects.toThrow('The app is closing');
  await expect(measurer.measure('C')).rejects.toThrow('The app is closing');
  expect(runs).toEqual([['A']]);
});

it('leaves no listener behind on the app-long signal once a pacing sleep ends', async () => {
  const stopping = new AbortController();
  const remove = vi.spyOn(stopping.signal, 'removeEventListener');

  await abortableSleep(1, stopping.signal);

  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});
