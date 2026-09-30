import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { DraftStore } from '../src/drafts/store.js';
import { PlaylistDraftTools } from '../src/tools/playlist_draft.js';
import { makeToolDeps } from './helpers.js';

function setup() {
  const deps = makeToolDeps();
  const shared = deps.drafts!();
  const local = new DraftStore(shared.path, { localOnly: true });
  const draftId = randomUUID();

  shared.create(draftId, 'Linked', ['T-TEARDROP', 'T-ROADS']);

  return { deps, shared, local, draftId };
}

it('refuses edits to a draft another client linked to the preview after the run began', async () => {
  const { deps, shared, local, draftId } = setup();
  const tools = new PlaylistDraftTools({ ...deps, drafts: () => local });
  const entries = [...local.get(draftId).entries].reverse();

  shared.claimPreview(draftId, 1, true);

  expect(await tools.edit({ draft_id: draftId, revision: 1, entries })).toMatchObject({
    error: 'preview_conflict',
  });
  expect(await tools.edit({ draft_id: draftId, revision: 1, name: 'x' })).toMatchObject({
    error: 'preview_conflict',
  });
  expect(shared.get(draftId).revision).toBe(1);

  for (const write of Object.values(deps.bridge)) expect(write).not.toHaveBeenCalled();
});

it('edits unlinked drafts and never starts a preview itself', async () => {
  const { deps, local, draftId } = setup();
  const tools = new PlaylistDraftTools({ ...deps, drafts: () => local });
  const entries = [...local.get(draftId).entries].reverse();

  expect(await tools.edit({ draft_id: draftId, revision: 1, entries })).toMatchObject({
    draft: { revision: 2 },
  });
  expect(() => local.claimPreview(draftId, 2, true)).toThrow('Previews are off');
  expect(local.preview()).toBeUndefined();
});
