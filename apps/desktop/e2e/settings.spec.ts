import { expect, test } from '../harness/fixture.js';

test('opens Settings from the app menu, and Hear the transition starts where the setting says', async ({
  electronApp,
  page,
  music,
  tracks,
}) => {
  const open = () =>
    electronApp.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()?.getMenuItemById('settings')?.click(),
    );
  const dialog = page.getByRole('dialog', { name: 'Settings' });

  // CmdOrCtrl+, is the menu item's own accelerator.
  expect(
    await electronApp.evaluate(
      ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('settings')?.accelerator,
    ),
  ).toBe('CmdOrCtrl+,');

  // Settings listens once the page has mounted.
  await expect(page.getByRole('heading', { name: 'Drafts' })).toBeVisible();
  await open();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('slider')).toHaveValue('60');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/settings.png' });

  // The slider runs right to left, as the picture does: left is a longer run-up.
  const slider = dialog.getByRole('slider');

  await slider.fill('30');
  await dialog.getByText('Most played').click();
  await expect(dialog.getByText(/Music may not have time to blend/)).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/settings-tight.png' });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Kept across a reload, as across a restart.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Drafts' })).toBeVisible();
  await open();
  await expect(dialog.getByRole('slider')).toHaveValue('30');
  await expect(dialog.getByRole('radio', { name: 'Most played' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Close settings' }).click();

  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Warm-up, nothing too loud');
  await page.getByRole('button', { name: 'Build it' }).click();
  await expect(page.getByRole('list', { name: 'Draft order' }).getByRole('listitem')).toHaveCount(
    8,
  );
  await expect(page.getByRole('heading', { name: /The crate/ })).toBeVisible();
  await expect(page.getByLabel(/Crate, most played/)).toBeVisible();
  await page.screenshot({ path: 'test-results/crate-most-played.png' });

  await page.getByRole('tab', { name: 'Listen' }).click();
  await expect(
    page.getByText('Plays the last 30 seconds of this track into the next.'),
  ).toBeVisible();
  music.setSpeed(0);
  await page.getByRole('button', { name: 'Hear the transition' }).click();

  await expect.poll(() => music.snapshot().player.state).toBe('playing');

  const { player, playlists } = music.snapshot();
  const playing = playlists.find((pl) => pl.name === 'Selecta Preview')!.tracks[player.index! - 1];

  expect(player.index).toBe(1);
  // The play script's own read-backs move the simulated clock a beat on.
  expect(player.position).toBeCloseTo(
    tracks.find((t) => t.persistentId === playing)!.duration - 30,
    0,
  );
  await page.screenshot({ path: 'test-results/listen-join-30.png' });
});
