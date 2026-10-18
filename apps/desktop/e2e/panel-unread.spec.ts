import { expect, test } from '../harness/fixture.js';

let release: () => void;
const held = new Promise<void>((resolve) => (release = resolve));

test.use({
  claude: {
    script: async ({ draftId, call, say }) => {
      await held;

      const found = await call('search', { limit: 6, compact: false });

      await call('show_playlist_draft', {
        draft_id: draftId,
        name: 'Harness set',
        track_ids: found.tracks.map((t: { persistent_id: string }) => t.persistent_id),
      });
      say('Six records to start.');
    },
  },
});

test('lights the tucked edge for a reply that landed while the draft was closed', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Warm-up, nothing too loud');
  await page.getByRole('button', { name: 'Build it' }).click();
  await page.getByRole('button', { name: 'Hide Claude' }).click();
  await page.getByRole('button', { name: 'All drafts' }).click();
  release();

  await page.getByRole('button', { name: /Harness set/ }).click();
  await expect(page.getByRole('button', { name: 'Show Claude' })).toHaveClass(/\blit\b/);
  await page.getByRole('button', { name: 'Show Claude' }).click();
  await page.getByRole('button', { name: 'Hide Claude' }).click();
  await expect(page.getByRole('button', { name: 'Show Claude' })).not.toHaveClass(/\blit\b/);
});
