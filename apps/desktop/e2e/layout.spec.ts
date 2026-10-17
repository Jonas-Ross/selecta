import { expect, test } from '../harness/fixture.js';

const PARAGRAPH =
  'The playlist it was copying is your **Chill Vibes**: 13 of the 20 tracks were from it, and that playlist only has 24 tracks.';

test.use({
  claude: {
    script: async ({ draftId, call, say }) => {
      const found = await call('search', { limit: 8, compact: false });

      await call('show_playlist_draft', {
        draft_id: draftId,
        name: 'Long talk',
        track_ids: found.tracks.map((t: { persistent_id: string }) => t.persistent_id),
      });
      say(Array(30).fill(PARAGRAPH).join('\n\n'));
    },
  },
});

test('keeps the draft inside the window and the reply inside the panel under a long chat', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Good vibes');
  await page.getByRole('button', { name: 'Build it' }).click();
  await expect(page.getByRole('list', { name: 'Draft order' }).getByRole('listitem')).toHaveCount(
    8,
  );
  await expect(page.locator('.msg.from-claude')).toHaveCount(1);

  const fits = () =>
    page.evaluate(() => {
      const log = document.querySelector('.log')!;

      return {
        draftBottom: document.querySelector('.draft-main')!.getBoundingClientRect().bottom,
        window: innerHeight,
        logScrolls: log.scrollHeight > log.clientHeight,
        logOverflowX: log.scrollWidth - log.clientWidth,
      };
    });
  const { draftBottom, window, logScrolls, logOverflowX } = await fits();

  expect(draftBottom).toBeLessThanOrEqual(window);
  expect(logScrolls).toBe(true);
  expect(logOverflowX).toBe(0);
  await page.screenshot({ path: 'test-results/layout-long-chat.png' });
});
