import { expect, test } from '../harness/fixture.js';
import { sleeve } from '../harness/library.js';

test('refreshes the library from Home and measures what it brought in', async ({ page, music }) => {
  const refresh = page.getByRole('button', { name: 'Refresh library' });
  const status = page.locator('.topbar .library-line');

  await expect(status).toHaveText(/^Read /);
  await page.screenshot({ path: 'test-results/refresh-home-before.png' });

  music.addTrack({
    persistentId: 'ABCDEF0123456789',
    name: 'Fresh Arrival',
    artist: 'Newcomer',
    album: 'Just Bought',
    genre: 'Electronic',
    year: 2026,
    duration: 360,
    dateAdded: new Date().toISOString(),
    artwork: sleeve(200),
  });
  await refresh.click();

  // The fixture leaves every fifth record unmeasured; with the new one that is nine.
  await expect(status).toHaveText('Read just now · 9 measured');
  await expect(refresh).toBeEnabled();
  await page.screenshot({ path: 'test-results/refresh-home-after.png' });

  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Warm-up, nothing too loud');
  await page.getByRole('button', { name: 'Build it' }).click();
  await expect(page.getByRole('list', { name: 'Draft order' }).getByRole('listitem')).toHaveCount(
    8,
  );
  await page.getByRole('searchbox').fill('Fresh Arrival');
  await expect(page.locator('.peek')).toContainText('Fresh Arrival');
  await expect(page.locator('.peek')).toContainText('126');
  await page.screenshot({ path: 'test-results/refresh-crate.png' });
});
