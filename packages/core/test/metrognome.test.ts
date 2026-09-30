// The metrognome subprocess adapter and the analysis enrichment pass.
//
// fixtures/metrognome.jsonl is real `metrognome batch` output, recorded
// against a local iTunes stand-in serving a synthesized 124 BPM A-minor clip,
// so the shapes here are the binary's own rather than a guess at them. Nothing
// in this file reaches the network; the one test that spawns a process spawns
// a node stub, never the real binary.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { SelectaCache } from '../src/cache/index.js';
import { blankFeatures, mergeFeatures } from '../src/cache/audio_features.js';
import {
  METROGNOME_PATH_ENV,
  analyzeTracks,
  enrichPendingTracks,
  metrognomePath,
  toFeaturesRow,
  type ChildLike,
} from '../src/enrich/index.js';
import { handleEnrichFeatures, type EnrichFeaturesOutput } from '../src/tools/enrich_features.js';
import type { LibrarySnapshot } from '../src/types/bridge.js';
import type { AudioFeaturesRow } from '../src/types/cache.js';
import { featuresRow, makeBridge } from './helpers.js';
import libraryFixture from './fixtures/library.json' with { type: 'json' };

const snapshot = libraryFixture as LibrarySnapshot;
const FETCHED_AT = '2026-09-18T00:00:00.000Z';

const recorded = readFileSync(new URL('./fixtures/metrognome.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '');

/** One recorded line by the client_ref it echoes back. */
function line(clientRef: string): string {
  const found = recorded.find(
    (raw) =>
      (JSON.parse(raw) as { query?: { client_ref?: string } }).query?.client_ref === clientRef,
  );

  if (found == null) throw new Error(`no recorded metrognome line for ${clientRef}`);

  return found;
}

function parsed(clientRef: string): Record<string, any> {
  return JSON.parse(line(clientRef));
}

/** A stand-in child process: collects stdin lines, then answers and exits. */
function stubChild(
  answer: (input: string[]) => { lines: string[]; code?: number; signal?: string },
): { child: ChildLike; input: () => string[] } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events = new EventEmitter();
  const input: string[] = [];
  let buffered = '';

  stdin.on('data', (chunk) => {
    buffered += String(chunk);
    const parts = buffered.split('\n');

    buffered = parts.pop()!;
    input.push(...parts.filter((part) => part !== ''));
  });

  stdin.on('finish', () => {
    const { lines, code = 0, signal } = answer(input);

    for (const out of lines) stdout.write(`${out}\n`);

    stdout.end();
    stderr.end();
    stdout.on('end', () => events.emit('close', code, signal ?? null));
  });

  return {
    child: {
      stdin,
      stdout,
      stderr,
      on: (event: string, listener: (...args: never[]) => void) => events.on(event, listener),
    } as unknown as ChildLike,
    input: () => input,
  };
}

const echoStub = (child: ChildLike) => () => child;

async function collect(
  queries: { clientRef: string; artist: string; title: string }[],
  answer: (input: string[]) => { lines: string[]; code?: number; signal?: string },
): Promise<{ rows: (AudioFeaturesRow | null)[]; input: string[] }> {
  const stub = stubChild(answer);
  const rows: (AudioFeaturesRow | null)[] = [];

  await analyzeTracks(queries, (analysis) => rows.push(toFeaturesRow(analysis, FETCHED_AT)), {
    spawnLike: echoStub(stub.child),
  });

  return { rows, input: stub.input() };
}

describe('metrognome binary path', () => {
  it('prefers an explicit path, then the environment, then PATH', () => {
    expect(metrognomePath({ binaryPath: '/opt/mg' })).toBe('/opt/mg');
    expect(METROGNOME_PATH_ENV).toBe('SELECTA_METROGNOME_PATH');
    expect(metrognomePath()).toBe(process.env[METROGNOME_PATH_ENV] ?? 'metrognome');
  });
});

describe('reading recorded metrognome output', () => {
  it('sends artist, title and the persistent ID as client_ref, and nothing else', async () => {
    const { input } = await collect(
      [{ clientRef: 'T-MIDNIGHT', artist: 'M83', title: 'Midnight City' }],
      () => ({ lines: [line('T-MIDNIGHT')] }),
    );

    expect(input.map((raw) => JSON.parse(raw))).toEqual([
      { artist: 'M83', title: 'Midnight City', client_ref: 'T-MIDNIGHT' },
    ]);
  });

  it('stores a confident estimate with its confidence, maturity and camelot', async () => {
    const fixture = parsed('T-MIDNIGHT');
    const { rows } = await collect(
      [{ clientRef: 'T-MIDNIGHT', artist: 'M83', title: 'Midnight City' }],
      () => ({ lines: [line('T-MIDNIGHT')] }),
    );

    expect(fixture.features.tempo.uncertain).toBe(false);
    expect(rows[0]).toMatchObject({
      trackPersistentId: 'T-MIDNIGHT',
      status: 'ok',
      analysisStatus: 'ok',
      catalogStatus: null,
      bpm: fixture.features.tempo.bpm,
      bpmConfidence: fixture.features.tempo.confidence,
      bpmMaturity: 'validated',
      sources: { bpm: fixture.features.tempo.source },
    });
    // The clip was synthesized at 124 BPM; the recorded estimate agrees.
    expect(rows[0]!.bpm).toBeCloseTo(124, 0);
  });

  it('drops an estimate the analyzer flagged uncertain rather than storing a hint', async () => {
    // The recorded line with only the uncertain flag flipped: nothing else
    // about the estimate changes, so the flag alone decides.
    const fixture = parsed('T-MIDNIGHT');

    fixture.features.tempo.uncertain = true;
    fixture.features.key.uncertain = true;
    const { rows } = await collect(
      [{ clientRef: 'T-MIDNIGHT', artist: 'M83', title: 'Midnight City' }],
      () => ({ lines: [JSON.stringify(fixture)] }),
    );

    expect(rows[0]).toMatchObject({
      bpm: null,
      musicalKey: null,
      camelot: null,
      sources: null,
      // Reached the audio and stood behind nothing: terminal, not pending.
      status: 'no_data',
      analysisStatus: 'no_data',
    });
  });

  it('records a store miss and an undecodable preview terminally', async () => {
    const { rows } = await collect(
      [
        { clientRef: 'T-GLORYBOX', artist: 'Portishead', title: 'Glory Box' },
        { clientRef: 'T-TEARDROP', artist: 'Massive Attack', title: 'Teardrop' },
      ],
      () => ({ lines: [line('T-GLORYBOX'), line('T-TEARDROP')], code: 1 }),
    );

    expect(parsed('T-GLORYBOX').error.kind).toBe('no_match');
    expect(parsed('T-TEARDROP').error.kind).toBe('decode');
    expect(rows.map((row) => row?.analysisStatus)).toEqual(['no_match', 'no_data']);
  });

  it('leaves a track pending when the failure was the environment, not the track', () => {
    const transient = { ...parsed('T-GLORYBOX'), error: { kind: 'http', message: 'timed out' } };

    expect(toFeaturesRow(transient as never, FETCHED_AT)).toBeNull();
  });

  it('ignores a result it cannot attribute to a row', () => {
    const orphan = parsed('T-MIDNIGHT');

    orphan.query = {};
    expect(toFeaturesRow(orphan as never, FETCHED_AT)).toBeNull();
  });
});

describe('contract failures', () => {
  it('refuses a schema_version it does not understand', async () => {
    const future = { ...parsed('T-MIDNIGHT'), schema_version: 99 };

    await expect(
      collect([{ clientRef: 'T-MIDNIGHT', artist: 'M83', title: 'Midnight City' }], () => ({
        lines: [JSON.stringify(future)],
      })),
    ).rejects.toThrow(/schema_version 99/);
  });

  it('refuses a line that is not the contract', async () => {
    await expect(
      collect([{ clientRef: 'T-MIDNIGHT', artist: 'M83', title: 'Midnight City' }], () => ({
        lines: ['not json at all'],
      })),
    ).rejects.toThrow(/non-JSON line/);
  });

  it('reports a run that ended before every track came back', async () => {
    await expect(
      collect(
        [
          { clientRef: 'T-MIDNIGHT', artist: 'M83', title: 'Midnight City' },
          { clientRef: 'T-GLORYBOX', artist: 'Portishead', title: 'Glory Box' },
        ],
        () => ({ lines: [line('T-MIDNIGHT')], signal: 'SIGKILL' }),
      ),
    ).rejects.toThrow(/ended after 1\/2 results \(signal SIGKILL\)/);
  });

  it('reports rather than hangs when the process dies with input still unwritten', async () => {
    // stdin is never read, so write() returns false and the drain that the
    // writer waits on can only come from a process that is already gone.
    const stdin = new PassThrough({ highWaterMark: 1 });
    const stdout = new PassThrough();
    const events = new EventEmitter();

    stdin.pause();
    stdout.end();
    setTimeout(() => events.emit('close', null, 'SIGKILL'), 10);

    await expect(
      analyzeTracks(
        Array.from({ length: 200 }, (_, i) => ({
          clientRef: `T-${i}`,
          artist: 'Artist',
          title: 'Title',
        })),
        () => {},
        {
          spawnLike: () =>
            ({
              stdin,
              stdout,
              stderr: new PassThrough().end(),
              on: (event: string, listener: (...args: never[]) => void) =>
                events.on(event, listener),
            }) as unknown as ChildLike,
        },
      ),
    ).rejects.toThrow(/ended after 0\/200 results \(signal SIGKILL\)/);
  });

  it('reports a binary that cannot be run, naming the override', async () => {
    await expect(
      analyzeTracks(
        [{ clientRef: 'T-MIDNIGHT', artist: 'M83', title: 'Midnight City' }],
        () => {},
        {
          binaryPath: '/nonexistent/metrognome',
          spawnLike: () => {
            throw new Error('spawn ENOENT');
          },
        },
      ),
    ).rejects.toThrow(/SELECTA_METROGNOME_PATH/);
  });
});

describe('driving a real subprocess', () => {
  it('streams results back over a live pipe, in input order', async () => {
    // A node stub rather than the real binary: this test is about the pipe
    // wiring, and CI has no metrognome installed.
    const directory = mkdtempSync(join(tmpdir(), 'selecta-metrognome-'));
    const script = join(directory, 'stub.mjs');

    writeFileSync(
      script,
      `import { createInterface } from 'node:readline';
       const answers = ${JSON.stringify({
         'T-MIDNIGHT': line('T-MIDNIGHT'),
         'T-GLORYBOX': line('T-GLORYBOX'),
       })};
       const lines = createInterface({ input: process.stdin });
       process.stderr.write('stub running\\n');
       for await (const raw of lines) console.log(answers[JSON.parse(raw).client_ref]);`,
    );

    const rows: (AudioFeaturesRow | null)[] = [];
    const logs: string[] = [];

    await analyzeTracks(
      [
        { clientRef: 'T-MIDNIGHT', artist: 'M83', title: 'Midnight City' },
        { clientRef: 'T-GLORYBOX', artist: 'Portishead', title: 'Glory Box' },
      ],
      (analysis) => rows.push(toFeaturesRow(analysis, FETCHED_AT)),
      {
        binaryPath: process.execPath,
        // The stub takes the script path where metrognome takes `batch`.
        spawnLike: (command, args) =>
          spawn(command, [script, ...args.slice(1)], { stdio: ['pipe', 'pipe', 'pipe'] }),
        trace: (entry) => logs.push(entry),
      },
    );

    expect(rows.map((row) => row?.trackPersistentId)).toEqual(['T-MIDNIGHT', 'T-GLORYBOX']);
    // stderr is the log channel and never reaches the result stream.
    expect(logs).toContain('metrognome: stub running');
  });
});

describe('merging one pass into the other', () => {
  it('fills gaps and never overwrites a value another source supplied', () => {
    const stored = featuresRow({
      trackPersistentId: 'T-TEARDROP',
      bpm: 78.42,
      musicalKey: null,
      danceability: 0.618,
      sources: { bpm: 'deezer', danceability: 'acousticbrainz' },
    });
    const analyzed: AudioFeaturesRow = {
      ...blankFeatures('T-TEARDROP', FETCHED_AT),
      bpm: 156,
      bpmConfidence: 0.9,
      bpmMaturity: 'validated',
      musicalKey: 'A minor',
      camelot: '8A',
      keyConfidence: 0.71,
      keyMaturity: 'provisional',
      sources: { bpm: 'metrognome/tempo@1', musicalKey: 'metrognome/key@1' },
      status: 'ok',
      analysisStatus: 'ok',
    };

    const merged = mergeFeatures(stored, analyzed);

    expect(merged.row).toMatchObject({
      bpm: 78.42, // Deezer's stands; metrognome's 156 is not an improvement it can prove.
      bpmConfidence: null,
      musicalKey: 'A minor',
      camelot: '8A',
      keyConfidence: 0.71,
      keyMaturity: 'provisional',
      danceability: 0.618,
      sources: {
        bpm: 'deezer',
        musicalKey: 'metrognome/key@1',
        danceability: 'acousticbrainz',
      },
      catalogStatus: 'ok',
      analysisStatus: 'ok',
      status: 'ok',
    });
    // The key gap-filled even though bpm didn't — landed tracks the row, not the source.
    expect(merged.landed).toBe(true);
  });

  it('keeps each pass’s own terminal record and reports the better one', () => {
    const exhausted = featuresRow({
      bpm: null,
      musicalKey: null,
      danceability: null,
      sources: null,
      status: 'no_match',
      catalogStatus: 'no_match',
    });
    const analyzed = {
      ...blankFeatures('T-TEARDROP', FETCHED_AT),
      status: 'no_data' as const,
      analysisStatus: 'no_data' as const,
    };

    const merged = mergeFeatures(exhausted, analyzed);

    expect(merged.row).toMatchObject({
      catalogStatus: 'no_match',
      analysisStatus: 'no_data',
      status: 'no_data',
    });
    expect(merged.landed).toBe(false);
  });
});

describe('the analysis enrichment pass', () => {
  function seeded(): SelectaCache {
    const cache = SelectaCache.open(':memory:');

    cache.refreshFromSnapshot(snapshot, { durationMs: 1 });

    return cache;
  }

  function answeringStub(byRef: Record<string, string>) {
    const stub = stubChild((input) => ({
      lines: input.flatMap((raw) => {
        const ref = (JSON.parse(raw) as { client_ref: string }).client_ref;

        return byRef[ref] != null ? [byRef[ref]] : [];
      }),
    }));

    return { metrognome: { spawnLike: echoStub(stub.child) }, input: stub.input };
  }

  it('analyzes tracks the catalogs already exhausted, and saves what it learns', async () => {
    const cache = seeded();

    cache.saveAudioFeatures([
      featuresRow({
        trackPersistentId: 'T-MIDNIGHT',
        bpm: null,
        musicalKey: null,
        danceability: null,
        sources: null,
        status: 'no_match',
        catalogStatus: 'no_match',
      }),
    ]);

    // A catalog dead end is still an analysis candidate.
    expect(cache.countPendingEnrichment('catalog')).toBe(snapshot.tracks.length - 1);
    expect(cache.countPendingEnrichment('analysis')).toBe(snapshot.tracks.length);

    const summary = await enrichPendingTracks(
      cache,
      { trackIds: ['T-MIDNIGHT'], source: 'analysis' },
      answeringStub({ 'T-MIDNIGHT': line('T-MIDNIGHT') }),
    );

    expect(summary).toMatchObject({ processed: 1, enriched: 1, returned: 1, skipped: 0 });
    expect(cache.getAudioFeatures('T-MIDNIGHT')).toMatchObject({
      bpm: parsed('T-MIDNIGHT').features.tempo.bpm,
      bpmMaturity: 'validated',
      camelot: parsed('T-MIDNIGHT').features.key.camelot,
      keyMaturity: 'provisional',
      catalogStatus: 'no_match',
      analysisStatus: 'ok',
      status: 'ok',
    });
    expect(cache.getTrack('T-MIDNIGHT')!.bpm).toBe(parsed('T-MIDNIGHT').features.tempo.bpm);
    cache.close();
  });

  it('returns without enriching when gap-fill discards the estimate', async () => {
    // Regression: the summary used to count this as enriched because
    // metrognome stood behind an estimate, even though nothing changed —
    // T-MIDNIGHT already has a catalog bpm and key.
    const cache = seeded();

    cache.saveAudioFeatures([featuresRow({ trackPersistentId: 'T-MIDNIGHT' })]);

    const summary = await enrichPendingTracks(
      cache,
      { trackIds: ['T-MIDNIGHT'], source: 'analysis' },
      answeringStub({ 'T-MIDNIGHT': line('T-MIDNIGHT') }),
    );

    expect(summary).toMatchObject({ processed: 1, returned: 1, enriched: 0 });
    expect(cache.getAudioFeatures('T-MIDNIGHT')).toMatchObject({
      bpm: 78.42, // the catalog's value, not metrognome's 124.01
      musicalKey: 'A minor', // the catalog's, unchanged
      analysisStatus: 'ok',
      catalogStatus: 'ok',
    });
    cache.close();
  });

  it('names each track as its result streams back, between chunk saves', async () => {
    const cache = seeded();
    const ticks: [number, string | null][] = [];

    await enrichPendingTracks(
      cache,
      { trackIds: ['T-MIDNIGHT', 'T-TEARDROP'], source: 'analysis' },
      {
        ...answeringStub({
          'T-MIDNIGHT': line('T-MIDNIGHT'),
          'T-TEARDROP': line('T-TEARDROP'),
        }),
        onProgress: (p, current) => ticks.push([p.processed, current]),
      },
    );

    // Results stream one at a time but save 25 at a time, so the name is the
    // only thing that moves until the flush.
    expect(ticks).toEqual([
      // Seeded before the binary is even spawned, so a slow first preview
      // still shows a line rather than nothing.
      [0, null],
      [0, 'Midnight City — M83'],
      [0, 'Teardrop — Massive Attack'],
      [2, 'Teardrop — Massive Attack'],
    ]);
    cache.close();
  });

  it('works the backlog in most-played order and leaves the catalog backlog alone', async () => {
    const cache = seeded();
    const stub = answeringStub({ 'T-MIDNIGHT': line('T-MIDNIGHT') });
    const summary = await enrichPendingTracks(cache, { limit: 1, source: 'analysis' }, stub);

    expect(stub.input().map((raw) => JSON.parse(raw).client_ref)).toEqual(['T-MIDNIGHT']);
    expect(summary.pendingRemaining).toBe(snapshot.tracks.length - 1);
    expect(cache.countPendingEnrichment('catalog')).toBe(snapshot.tracks.length);
    cache.close();
  });

  it('reports a second attempt on the same source as already attempted', async () => {
    const cache = seeded();

    await enrichPendingTracks(
      cache,
      { trackIds: ['T-MIDNIGHT'], source: 'analysis' },
      answeringStub({ 'T-MIDNIGHT': line('T-MIDNIGHT') }),
    );
    const again = await enrichPendingTracks(
      cache,
      { trackIds: ['T-MIDNIGHT'], source: 'analysis' },
      answeringStub({}),
    );

    expect(again).toMatchObject({
      processed: 0,
      alreadyAttempted: 1,
      outcomes: [
        {
          trackPersistentId: 'T-MIDNIGHT',
          outcome: 'already_attempted',
          existingResult: 'enriched',
        },
      ],
    });
    cache.close();
  });

  it('keeps whatever streamed back when the run dies part-way', async () => {
    const cache = seeded();
    const stub = stubChild((input) => ({
      lines: [line((JSON.parse(input[0]!) as { client_ref: string }).client_ref)],
      signal: 'SIGKILL',
    }));
    const summary = await enrichPendingTracks(
      cache,
      { trackIds: ['T-MIDNIGHT', 'T-TEARDROP'], source: 'analysis' },
      { metrognome: { spawnLike: echoStub(stub.child) } },
    );

    expect(summary).toMatchObject({ processed: 1, enriched: 1, skipped: 1 });
    expect(summary.errors[0]).toMatch(/ended after 1\/2 results/);
    expect(cache.getAudioFeatures('T-MIDNIGHT')!.analysisStatus).toBe('ok');
    // The unanswered track stays pending rather than being recorded as a miss.
    expect(cache.getAudioFeatures('T-TEARDROP')).toBeNull();
    cache.close();
  });

  it('fails soft when the binary is missing: nothing stored, reason reported', async () => {
    const cache = seeded();
    const deps = {
      cache: () => cache,
      bridge: makeBridge(),
      enrich: {
        metrognome: {
          binaryPath: '/nonexistent/metrognome',
          spawnLike: () => {
            throw new Error('spawn ENOENT');
          },
        },
      },
    };
    const out = (await handleEnrichFeatures(
      { source: 'analysis', limit: 2 },
      deps,
    )) as EnrichFeaturesOutput;

    expect(out).toMatchObject({ processed: 0, enriched: 0, skipped: 2 });
    expect(out.source_errors![0]).toMatch(/could not be run at "\/nonexistent\/metrognome"/);
    expect(cache.countPendingEnrichment('analysis')).toBe(snapshot.tracks.length);
    cache.close();
  });
});
