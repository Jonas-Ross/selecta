import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleOpenPreview } from '../src/tools/open_preview.js';
import { withOperation } from '../src/operations/lock.js';
import { BridgeError } from '../src/types/errors.js';
import { asError, makeToolDeps } from './helpers.js';

const deps = makeToolDeps();

afterEach(() => vi.clearAllMocks());

describe('open_preview', () => {
  it('forwards the complete occurrence order without writing or refreshing the library', async () => {
    vi.mocked(deps.bridge.openPreview).mockResolvedValue({ persistentId: 'P', trackCount: 3 });
    const before = deps.cacheInstance.db.prepare('SELECT total_changes() AS count').get();

    expect(await handleOpenPreview({ track_ids: ['A', 'B', 'A'] }, deps)).toEqual({
      playlist_id: 'P',
      track_count: 3,
      opened: true,
    });
    expect(deps.bridge.openPreview).toHaveBeenCalledExactlyOnceWith({
      expectedTrackIds: ['A', 'B', 'A'],
    });
    expect(deps.bridge.replacePlaylist).not.toHaveBeenCalled();
    expect(deps.bridge.readLibrary).not.toHaveBeenCalled();
    expect(deps.cacheInstance.db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
  });

  it.each([
    {},
    { track_ids: [] },
    { track_ids: [''] },
    { track_ids: ['A'], playlist_id: 'P' },
    { track_ids: Array(501).fill('A') },
  ])('rejects invalid input before accessing Music: %j', async (input) => {
    expect(asError(await handleOpenPreview(input, deps)).error).toBe('validation_error');
    expect(deps.bridge.openPreview).not.toHaveBeenCalled();
  });

  it('excludes preview replacement and other Music operations', async () => {
    await withOperation(deps.cacheInstance, 'music', async () => {
      expect(asError(await handleOpenPreview({ track_ids: ['A'] }, deps)).error).toBe(
        'operation_busy',
      );
    });
    expect(deps.bridge.openPreview).not.toHaveBeenCalled();
  });

  it('preserves structured failure without a retry or fallback', async () => {
    vi.mocked(deps.bridge.openPreview).mockRejectedValue(
      new BridgeError('automation_permission_denied', 'Automation denied', 'Enable Automation.'),
    );
    expect(await handleOpenPreview({ track_ids: ['A'] }, deps)).toMatchObject({
      error: 'automation_permission_denied',
      hint: 'Enable Automation.',
    });
    expect(deps.bridge.openPreview).toHaveBeenCalledOnce();
  });
});
