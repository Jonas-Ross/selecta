import { expect, test } from '../harness/fixture.js';

test('slides the agent panel off to an edge, gives the draft the width, and remembers it', async ({
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
  const width = async () => (await main.boundingBox())!.width;
  // How much of the panel is on screen; it slides, so its own width never changes.
  const showing = async () =>
    (await page.evaluate(() => innerWidth)) - (await panel.boundingBox())!.x;
  const typing = page.getByLabel('Message to Claude');
  const inert = () => typing.evaluate((el) => el.closest('[inert]') !== null);
  const open = await width();

  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/panel-open.png' });
  const codex = (await panel.getByText('Codex').boundingBox())!;

  await page.mouse.move(codex.x + codex.width / 2, codex.y + codex.height / 2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/panel-agent-hover.png' });
  await page.getByRole('button', { name: 'Hide Claude' }).hover();
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test-results/panel-toggle-hover.png' });
  await page.getByRole('button', { name: 'Hide Claude' }).click();
  // The draft takes the width at once, under the panel, rather than reflowing as it slides.
  expect(await width()).toBeGreaterThan(open + 250);
  await page.waitForTimeout(120);
  expect(await showing()).toBeGreaterThan(21);
  await expect.poll(showing).toBeLessThanOrEqual(21);
  expect(await inert()).toBe(true);
  await page.mouse.move(200, 200);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/panel-collapsed.png' });

  // Kept across a reload, as across a restart.
  await page.reload();
  await page.getByRole('button', { name: /Harness set/ }).click();
  await expect(page.getByRole('button', { name: 'Show Claude' })).toBeVisible();
  await expect.poll(showing).toBeLessThanOrEqual(21);

  // Opening slides over the draft first and only then gives the width back.
  await page.keyboard.press('Control+Backslash');
  await page.waitForTimeout(120);
  expect(await width()).toBeGreaterThan(open + 250);
  await expect.poll(width).toBe(open);
  expect(await showing()).toBeGreaterThan(280);
  expect(await inert()).toBe(false);
  await page.getByRole('button', { name: 'Hide Claude' }).click();
  await page.getByRole('button', { name: 'Show Claude' }).click();
  await expect.poll(width).toBe(open);
});
