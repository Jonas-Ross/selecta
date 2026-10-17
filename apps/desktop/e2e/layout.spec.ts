import { buildFromSearch, expect, test } from '../harness/fixture.js';

const PARAGRAPH =
  'The playlist it was copying is your **Chill Vibes**: 13 of the 20 tracks were from it, and that playlist only has 24 tracks.';

test.use({
  claude: {
    script: async (turn) => {
      await buildFromSearch()(turn);
      turn.say(Array(30).fill(PARAGRAPH).join('\n\n'));
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
  await expect(page.locator('.msg.from-claude')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/layout-long-chat.png' });

  const { transportBottom, viewportHeight, logScrolls, logOverflowX } = await page.evaluate(() => {
    const log = document.querySelector('.log')!;

    return {
      transportBottom: document.querySelector('.transport')!.getBoundingClientRect().bottom,
      viewportHeight: innerHeight,
      logScrolls: log.scrollHeight > log.clientHeight,
      logOverflowX: log.scrollWidth - log.clientWidth,
    };
  });

  expect(transportBottom).toBeLessThanOrEqual(viewportHeight);
  expect(logScrolls).toBe(true);
  expect(logOverflowX).toBe(0);
});
