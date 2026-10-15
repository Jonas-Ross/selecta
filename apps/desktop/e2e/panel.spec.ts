import { expect, test } from '../harness/fixture.js';

test('tucks the agent panel to an edge, gives the draft the width, and remembers it', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Warm-up, nothing too loud');
  await page.getByRole('button', { name: 'Build it' }).click();
  await expect(page.getByRole('list', { name: 'Draft order' }).getByRole('listitem')).toHaveCount(
    8,
  );

  const panel = page.getByRole('complementary', { name: 'Claude' });
  const main = page.getByRole('region', { name: 'Draft' });
  const width = async (locator: typeof panel) => (await locator.boundingBox())!.width;
  const typing = page.getByLabel('Message to Claude');
  const inert = () => typing.evaluate((el) => el.closest('[inert]') !== null);
  const open = await width(main);

  await page.screenshot({ path: 'test-results/panel-open.png' });
  await page.getByRole('button', { name: 'Hide Claude' }).click();
  // The column slides rather than jumping.
  await page.waitForTimeout(150);
  expect(await width(panel)).toBeGreaterThan(41);
  await expect.poll(() => width(panel)).toBeLessThanOrEqual(41);
  expect(await width(main)).toBeGreaterThan(open + 250);
  expect(await inert()).toBe(true);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/panel-collapsed.png' });

  // Kept across a reload, as across a restart.
  await page.reload();
  await page.getByRole('button', { name: /Harness set/ }).click();
  await expect(page.getByRole('button', { name: 'Show Claude' })).toBeVisible();
  await expect.poll(() => width(panel)).toBeLessThanOrEqual(41);

  await page.keyboard.press('Control+Backslash');
  await expect.poll(() => width(panel)).toBeGreaterThan(280);
  expect(await inert()).toBe(false);
  await page.getByRole('button', { name: 'Hide Claude' }).click();
  await page.getByRole('button', { name: 'Show Claude' }).click();
  await expect.poll(() => width(panel)).toBeGreaterThan(280);
});
