import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { runJxa } from '../src/bridge/jxa.js';
import { BridgeError, type ErrorCode } from '../src/types/errors.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

// Drive the execFile callback the way Node does: (error, stdout, stderr).
// On non-zero exit, `error` is an Error carrying the exit code; stdout/stderr
// are still delivered.
function stubExecFile(opts: { error?: Error | null; stdout?: string; stderr?: string }): void {
  mockExecFile.mockImplementation(((
    _cmd: string,
    _args: readonly string[],
    _options: object,
    cb: (e: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cb(opts.error ?? null, opts.stdout ?? '', opts.stderr ?? '');
    return {} as never;
  }) as never);
}

async function expectErrorCode(p: Promise<unknown>, code: ErrorCode): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(BridgeError);
  await expect(p).rejects.toMatchObject({ errorCode: code });
}

describe('runJxa', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('parses stdout JSON on success', async () => {
    stubExecFile({ stdout: '{"persistentId":"ABC","name":"x"}' });
    await expect(runJxa('noop')).resolves.toEqual({ persistentId: 'ABC', name: 'x' });
  });

  it('throws jxa_error when stdout is not valid JSON', async () => {
    stubExecFile({ stdout: 'not json at all' });
    await expectErrorCode(runJxa('noop'), 'jxa_error');
  });

  it('maps a macOS automation privilege denial to automation_permission_denied', async () => {
    stubExecFile({
      error: new Error('Command failed'),
      stderr:
        'execution error: Not authorized to send Apple events to Music. (-1743) errAEPrivilegeError',
    });
    await expectErrorCode(runJxa('noop'), 'automation_permission_denied');
  });

  it('maps an app-not-running signature to music_app_not_running', async () => {
    stubExecFile({
      error: new Error('Command failed'),
      stderr: "execution error: Application isn't running. (-600)",
    });
    await expectErrorCode(runJxa('noop'), 'music_app_not_running');
  });

  it('maps any other non-zero exit to jxa_error', async () => {
    stubExecFile({
      error: new Error('Command failed'),
      stderr: 'execution error: something unexpected happened (-2700)',
    });
    await expectErrorCode(runJxa('noop'), 'jxa_error');
  });
});

// The edit scripts return guard sentinels instead of mutating when the live
// library disagrees with the request; the bridge maps each to a BridgeError.
describe('bridge result sentinel mapping', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  async function editBridge() {
    return (await import('../src/bridge/index.js')).bridge;
  }
  const input = { playlistId: 'P1', trackIds: ['T1'] };

  it('maps playlistNotFound to playlist_not_found', async () => {
    stubExecFile({ stdout: '{"playlistNotFound":true}' });
    await expectErrorCode((await editBridge()).addPlaylistTracks(input), 'playlist_not_found');
  });

  it('maps notEditable to playlist_not_editable', async () => {
    stubExecFile({ stdout: '{"notEditable":true}' });
    await expectErrorCode((await editBridge()).addPlaylistTracks(input), 'playlist_not_editable');
  });

  it('maps missingTrackIds to track_not_found, naming the IDs', async () => {
    stubExecFile({ stdout: '{"missingTrackIds":["T1"]}' });
    const p = (await editBridge()).removePlaylistTracks(input);
    await expectErrorCode(p, 'track_not_found');
  });

  it('maps invalidPositions to validation_error with the live count in the hint', async () => {
    stubExecFile({ stdout: '{"invalidPositions":[9],"liveTrackCount":3}' });
    const p = (await editBridge()).removePlaylistTracks({ playlistId: 'P1', positions: [9] });
    await expect(p).rejects.toMatchObject({
      errorCode: 'validation_error',
      hint: expect.stringContaining('3 tracks'),
    });
  });

  it('returns the parsed result on the success shape', async () => {
    stubExecFile({
      stdout:
        '{"persistentId":"P1","trackCount":2,"trackPersistentIds":["T1","T2"],"preEditTrackPersistentIds":["T1","T2","T3"],"removedCount":1}',
    });
    await expect((await editBridge()).removePlaylistTracks(input)).resolves.toEqual({
      persistentId: 'P1',
      trackCount: 2,
      trackPersistentIds: ['T1', 'T2'],
      preEditTrackPersistentIds: ['T1', 'T2', 'T3'],
      removedCount: 1,
    });
  });

  it('maps a missing clone source to playlist_not_found', async () => {
    stubExecFile({ stdout: '{"playlistNotFound":true}' });
    await expectErrorCode(
      (await editBridge()).clonePlaylist({ name: 'x', sourcePlaylistId: 'P-NOPE' }),
      'playlist_not_found',
    );
  });

  it('tells the model to rebuild a missing reserved slot instead of refreshing', async () => {
    stubExecFile({ stdout: '{"playlistNotFound":true}' });
    await expect(
      (await editBridge()).clonePlaylist({
        name: 'x',
        sourcePlaylistId: 'P-STALE',
        reservedSourceName: 'Selecta Preview',
      }),
    ).rejects.toMatchObject({
      errorCode: 'playlist_not_found',
      hint: expect.stringContaining('preview_playlist'),
    });
  });

  it('maps an ambiguous reserved slot to validation_error naming every copy', async () => {
    stubExecFile({
      stdout: '{"ambiguousSource":{"name":"Selecta Preview","persistentIds":["P-ONE","P-TWO"]}}',
    });
    await expect(
      (await editBridge()).clonePlaylist({
        name: 'x',
        sourcePlaylistId: 'P-STALE',
        reservedSourceName: 'Selecta Preview',
      }),
    ).rejects.toMatchObject({
      errorCode: 'validation_error',
      hint: expect.stringContaining('Nothing was created'),
      message: expect.stringContaining('P-ONE, P-TWO'),
    });
  });

  it('returns whether replacePlaylist created the slot, rejecting a result without it', async () => {
    stubExecFile({ stdout: '{"persistentId":"P-SLOT","trackCount":2,"created":true}' });
    await expect(
      (await editBridge()).replacePlaylist({ name: 'Selecta Preview', trackIds: ['T1', 'T2'] }),
    ).resolves.toEqual({ persistentId: 'P-SLOT', trackCount: 2, created: true });

    stubExecFile({ stdout: '{"persistentId":"P-SLOT","trackCount":2}' });
    await expectErrorCode(
      (await editBridge()).replacePlaylist({ name: 'Selecta Preview', trackIds: ['T1', 'T2'] }),
      'jxa_error',
    );
  });

  it('rejects a non-user clone source as playlist_not_editable', async () => {
    stubExecFile({ stdout: '{"sourceNotUser":true,"sourceKind":"smart"}' });
    await expect(
      (await editBridge()).clonePlaylist({ name: 'x', sourcePlaylistId: 'P-SMART' }),
    ).rejects.toMatchObject({
      errorCode: 'playlist_not_editable',
      hint: expect.stringContaining('plain user'),
    });
  });

  it.each([0, 501])('rejects a clone source with %i live entries', async (trackCount) => {
    stubExecFile({ stdout: JSON.stringify({ invalidSourceTrackCount: trackCount }) });
    await expect(
      (await editBridge()).clonePlaylist({ name: 'x', sourcePlaylistId: 'P-SOURCE' }),
    ).rejects.toMatchObject({
      errorCode: 'validation_error',
      hint: expect.stringContaining('Nothing was created'),
    });
  });

  it('uses clone-specific guidance for unavailable live source entries', async () => {
    stubExecFile({ stdout: '{"missingTrackIds":["T-DANGLING"]}' });
    await expect(
      (await editBridge()).clonePlaylist({ name: 'x', sourcePlaylistId: 'P-SOURCE' }),
    ).rejects.toMatchObject({
      errorCode: 'track_not_found',
      hint: expect.stringContaining('refresh_library cannot repair'),
    });
  });

  it('keeps stale-cache guidance for explicit-ID creation misses', async () => {
    stubExecFile({ stdout: '{"missingTrackIds":["T-MISSING"]}' });
    await expect(
      (await editBridge()).createPlaylist({ name: 'x', trackIds: ['T-MISSING'] }),
    ).rejects.toMatchObject({
      errorCode: 'track_not_found',
      hint: expect.stringContaining('cache is stale'),
    });
  });

  it('returns a clone result with the exact source order', async () => {
    stubExecFile({
      stdout:
        '{"persistentId":"P-NEW","trackCount":3,"sourcePersistentId":"P-SOURCE","sourceName":"Preview","sourceTrackPersistentIds":["T3","T1","T2"]}',
    });
    await expect(
      (await editBridge()).clonePlaylist({ name: 'Final', sourcePlaylistId: 'P-SOURCE' }),
    ).resolves.toEqual({
      persistentId: 'P-NEW',
      trackCount: 3,
      sourcePersistentId: 'P-SOURCE',
      sourceName: 'Preview',
      sourceTrackPersistentIds: ['T3', 'T1', 'T2'],
    });
  });

  it('rejects a clone result whose destination count differs from the source snapshot', async () => {
    stubExecFile({
      stdout:
        '{"persistentId":"P-NEW","trackCount":2,"sourcePersistentId":"P-SOURCE","sourceName":"Preview","sourceTrackPersistentIds":["T3","T1","T2"]}',
    });
    await expectErrorCode(
      (await editBridge()).clonePlaylist({ name: 'Final', sourcePlaylistId: 'P-SOURCE' }),
      'jxa_error',
    );
  });

  it('rejects an unexpected shape as jxa_error', async () => {
    stubExecFile({ stdout: '{"persistentId":"P1","trackCount":1,"trackPersistentIds":["T1"]}' });
    await expectErrorCode((await editBridge()).addPlaylistTracks(input), 'jxa_error');
  });
});
