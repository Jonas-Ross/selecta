import { expect, test } from '../harness/fixture.js';

const saved = (music: {
  snapshot: () => { playlists: { id: string; name: string; tracks: string[] }[] };
}) => music.snapshot().playlists.filter((pl) => pl.name !== 'Selecta Preview');

test('keeps a saved draft editable and updates the same playlist on the next save', async ({
  page,
  music,
}) => {
  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Warm-up, nothing too loud');
  await page.getByRole('button', { name: 'Build it' }).click();

  const records = page.getByRole('list', { name: 'Draft order' }).getByRole('listitem');

  await expect(records).toHaveCount(8);
  await page.getByRole('button', { name: 'Save to Music' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Saved "Harness set"/)).toBeVisible();

  const [first] = saved(music);

  expect(first).toBeDefined();
  await expect(page.getByText('Drag to reorder · right-click to replace')).toBeVisible();
  // Settle the card's fade and the rail's springs, for the screenshots.
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/save-after-saved.png' });

  await records.nth(4).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForTimeout(1200);

  const moved = [...first!.tracks];

  [moved[3], moved[4]] = [moved[4]!, moved[3]!];
  await page.getByRole('button', { name: 'Update in Music' }).click();
  await expect(page.getByRole('dialog')).toContainText("Replaces what's in “Harness set”");
  await page.screenshot({ path: 'test-results/save-after-update-confirm.png' });
  await page.getByRole('dialog').getByRole('button', { name: 'Update' }).click();
  await expect(page.getByText(/Updated "Harness set" in Music/)).toBeVisible();

  expect(saved(music)).toEqual([{ id: first!.id, name: 'Harness set', tracks: moved }]);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/save-after-updated.png' });
});

test('leaves a playlist changed in Music alone and saves a new one next time', async ({
  page,
  music,
}) => {
  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Warm-up, nothing too loud');
  await page.getByRole('button', { name: 'Build it' }).click();

  const records = page.getByRole('list', { name: 'Draft order' }).getByRole('listitem');

  await expect(records).toHaveCount(8);
  await page.getByRole('button', { name: 'Save to Music' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Saved "Harness set"/)).toBeVisible();

  const [first] = saved(music);
  const edited = first!.tracks.slice(1);

  music.run(`(() => {
    const Music = Application('Music');
    const pl = Music.playlists.whose({ persistentID: '${first!.id}' })()[0];
    Music.delete(pl.tracks[0]);
  })()`);
  expect(saved(music)[0]!.tracks).toEqual(edited);

  await records.nth(4).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.getByRole('button', { name: 'Update in Music' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Update' }).click();
  await expect(
    page.getByText(/changed or renamed in Music.app since it was saved. Nothing was written/),
  ).toBeVisible();
  expect(saved(music)[0]!.tracks).toEqual(edited);

  await page.getByRole('button', { name: 'Save to Music' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Saved "Harness set"/)).toBeVisible();
  expect(saved(music).filter((pl) => pl.name === 'Harness set')).toHaveLength(2);
});
