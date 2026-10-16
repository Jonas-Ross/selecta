import { expect, test } from '../harness/fixture.js';

test('slides the agent panel off to an edge with the draft widening in step, and remembers it', async ({
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
  const showing = async () =>
    (await page.evaluate(() => innerWidth)) - (await panel.boundingBox())!.x;
  // Every frame of a slide: the draft's width and how far its edge is from the panel's.
  const slide = async (act: () => Promise<void>) => {
    await page.evaluate(() => {
      // Slowed, so a loaded runner still paints frames mid-slide.
      document.documentElement.style.setProperty('--t-slide', '1.5s');

      const w = window as unknown as { slideFrames: [number, number][] };
      const main = document.querySelector('.draft-main')!;
      const panel = document.querySelector('.claude')!;
      const until = performance.now() + 1700;

      w.slideFrames = [];

      const tick = (t: number) => {
        const [d, p] = [main.getBoundingClientRect(), panel.getBoundingClientRect()];

        w.slideFrames.push([d.width, Math.abs(d.right - p.left)]);

        if (t < until) requestAnimationFrame(tick);
      };

      requestAnimationFrame(tick);
    });
    await act();
    await page.waitForTimeout(1800);

    return page.evaluate(
      () => (window as unknown as { slideFrames: [number, number][] }).slideFrames,
    );
  };
  const inStep = (frames: [number, number][], from: number, to: number) => {
    const [lo, hi] = [Math.min(from, to), Math.max(from, to)];

    expect(frames.some(([w]) => w > lo + 20 && w < hi - 20)).toBe(true);
    expect(Math.max(...frames.map(([, gap]) => gap))).toBeLessThanOrEqual(1);
  };

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
  const hiding = await slide(() => page.getByRole('button', { name: 'Hide Claude' }).click());
  const wide = await width();

  expect(wide).toBeGreaterThan(open + 250);
  inStep(hiding, open, wide);
  expect(await showing()).toBeLessThanOrEqual(21);
  expect(await inert()).toBe(true);
  await page.mouse.move(200, 200);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/panel-collapsed.png' });

  // Kept across a reload, as across a restart.
  await page.reload();
  await page.getByRole('button', { name: /Harness set/ }).click();
  await expect(page.getByRole('button', { name: 'Show Claude' })).toBeVisible();
  await expect.poll(showing).toBeLessThanOrEqual(21);

  inStep(await slide(() => page.keyboard.press('Control+Backslash')), wide, open);
  expect(await width()).toBe(open);
  expect(await showing()).toBeGreaterThan(280);
  expect(await inert()).toBe(false);
  await page.getByRole('button', { name: 'Hide Claude' }).click();
  await page.getByRole('button', { name: 'Show Claude' }).click();
  await expect.poll(width).toBe(open);
});
