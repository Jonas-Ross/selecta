// The app as shipped, against a simulated Music.app and a scripted Claude.
import type { Page } from '@playwright/test';
import { expect, test } from '../harness/fixture.js';

const preview = (music: { snapshot: () => { playlists: { name: string; tracks: string[] }[] } }) =>
  music.snapshot().playlists.find((pl) => pl.name === 'Selecta Preview')?.tracks;

async function build(page: Page) {
  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Warm-up, nothing too loud');
  await page.getByRole('button', { name: 'Build it' }).click();
  await expect(page.getByRole('list', { name: 'Draft order' }).getByRole('listitem')).toHaveCount(
    8,
  );
}

test('plays the draft through Selecta Preview, follows Music on, and keeps it in step with a reorder', async ({
  page,
  music,
  tracks,
  actions,
}) => {
  await build(page);
  await page.getByRole('tab', { name: 'Listen' }).click();
  await page.getByRole('button', { name: 'Play' }).click();

  const playing = page.locator('[role=listitem][aria-current=true]');
  const records = page.getByRole('list', { name: 'Draft order' }).getByRole('listitem');

  await expect(playing).toHaveCount(1);
  await expect(records.first()).toHaveAttribute('aria-current', 'true');
  expect(music.snapshot().player).toMatchObject({
    state: 'playing',
    playlist: 'Selecta Preview',
    index: 1,
  });

  // Music carries on through its queue by itself; the rail follows.
  const first = tracks.find((t) => t.persistentId === preview(music)![0])!;

  music.advance(first.duration);
  await expect(records.nth(1)).toHaveAttribute('aria-current', 'true');

  // A reorder on the rail while listening reaches the preview, so Music plays what the rail shows.
  const before = preview(music)!;

  await records.nth(4).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect
    .poll(() => preview(music))
    .toEqual([...before.slice(0, 3), before[4], before[3], ...before.slice(5)]);
  await expect(records.nth(1)).toHaveAttribute('aria-current', 'true');

  await page.screenshot({ path: 'test-results/listen.png' });
  expect(actions().filter((a) => a.method?.startsWith('player.') && a.error)).toEqual([]);
});

test('says why when shuffle is on in Music, and plays nothing', async ({ page, music }) => {
  music.shuffle = true;
  await build(page);
  await page.getByRole('tab', { name: 'Listen' }).click();
  await page.getByRole('button', { name: 'Play' }).click();

  await expect(page.getByText(/Shuffle is on/).first()).toBeVisible();
  expect(music.snapshot().player.state).toBe('stopped');
});

test.describe('when Claude reaches for a write the app never allows', () => {
  test.use({
    claude: {
      script: async ({ draftId, call }) => {
        await call('save_playlist_draft', { draft_id: draftId, revision: 1 });
      },
    },
  });

  test('shows the refusal', async ({ page }) => {
    await page.getByRole('button', { name: 'New playlist' }).first().click();
    await page.getByLabel('The brief').fill('Save it straight away');
    await page.getByRole('button', { name: 'Build it' }).click();

    await expect(
      page.getByText('save_playlist_draft is not allowed for the in-app agent.'),
    ).toBeVisible();
  });
});
