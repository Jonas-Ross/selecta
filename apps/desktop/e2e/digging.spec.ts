import { expect, test } from '../harness/fixture.js';

let release: () => void;
const held = new Promise<void>((resolve) => (release = resolve));

test.use({
  claude: {
    script: async ({ draftId, call, say }) => {
      await call('library_overview', {});
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

test('digs on the empty rail while the agent builds, then gives way to the records', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Warm-up, nothing too loud');
  await page.getByRole('button', { name: 'Build it' }).click();

  const digging = page.locator('.digging');

  await expect(digging).toContainText('Claude is digging');
  await expect(digging).toContainText('reading your library');
  await expect(digging.locator('.ghost.pulled')).toHaveCount(1);
  release();

  await expect(page.getByRole('list', { name: 'Draft order' }).getByRole('listitem')).toHaveCount(
    6,
  );
  await expect(digging).toHaveCount(0);
});
