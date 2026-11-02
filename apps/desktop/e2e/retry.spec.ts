import { buildFromSearch, expect, test } from '../harness/fixture.js';

const EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed';
let runs = 0;

test.use({
  claude: {
    script: async (turn) => {
      runs += 1;

      // The real CLI writes its login failure as a reply, then fails the run with it.
      if (runs === 1) {
        turn.say(EXPIRED);
        throw new Error(EXPIRED);
      }

      await buildFromSearch()(turn);
    },
  },
});

test('retries a brief that failed on a lapsed login, saying how to sign back in', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Riddim and heavy stuff');
  await page.getByRole('button', { name: 'Build it' }).click();

  const panel = page.getByRole('complementary');
  const retry = panel.getByRole('button', { name: 'Retry' });

  await expect(retry).toBeVisible();
  await expect(panel.locator('.msg')).toHaveCount(1);
  await expect(panel.locator('.msg.from-error')).toContainText(EXPIRED);
  await expect(panel.locator('.sign-in')).toHaveText(
    'Sign in again: run claude auth login in Terminal, then retry.',
  );
  await page.screenshot({ path: 'test-results/retry-failed.png' });

  await retry.click();
  await expect(page.getByRole('list', { name: 'Draft order' }).getByRole('listitem')).toHaveCount(
    8,
  );
  await expect(retry).toHaveCount(0);
  // The brief ran again as it was, without asking it twice.
  await expect(panel.locator('.brief-card')).toContainText('Riddim and heavy stuff');
  await expect(panel.locator('.msg.from-you')).toHaveCount(0);
  await expect(panel.locator('.msg.from-claude')).toHaveText(/Here are 8 records/);
  await page.screenshot({ path: 'test-results/retry-done.png' });
});
