import type { Page } from '@playwright/test';
import { expect, test } from '../harness/fixture.js';

async function open(page: Page) {
  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Something to just listen to');
  await page.getByRole('button', { name: 'Build it' }).click();
  await expect(page.getByRole('list', { name: 'Draft order' }).getByRole('listitem')).toHaveCount(
    8,
  );
  await page.getByRole('button', { name: 'Full screen' }).click();

  return page.getByRole('dialog', { name: 'Listening mode' });
}

test('plays the draft full screen, follows Music down the dock, and closes on Done', async ({
  page,
  music,
  tracks,
}) => {
  const mode = await open(page);
  const playing = mode.locator('.lm-tile[aria-current=true]');

  await expect(mode).toBeVisible();
  await mode.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(mode.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  expect(music.snapshot().player).toMatchObject({ state: 'playing', playlist: 'Selecta Preview' });

  const first = tracks.find((t) => t.persistentId === music.snapshot().player.track)!;
  const title = await mode.locator('h1').textContent();

  await expect(playing).toContainText(title!);

  await page.mouse.move(400, 300);
  await page.screenshot({ path: 'test-results/listening.png' });

  music.advance(first.duration - 30);
  await expect(mode.getByText(/^Transition in 0:[23]\d$/)).toBeVisible();
  await page.mouse.move(420, 320);
  await page.screenshot({ path: 'test-results/listening-transition.png' });

  music.advance(31);
  await expect(mode.locator('h1')).not.toHaveText(title!);
  await expect(mode.locator('.lm-tile').nth(0)).toHaveClass(/past/);
  await expect(mode.locator('.lm-tile').nth(1)).toHaveAttribute('aria-current', 'true');

  // Clicking a sleeve in the dock plays it in Music.
  await page.mouse.move(400, 300);
  await mode
    .getByRole('button', { name: /^Play / })
    .nth(3)
    .click();
  await expect(mode.locator('.lm-tile').nth(4)).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => music.snapshot().player.index).toBe(5);

  await mode.getByRole('button', { name: 'Done' }).click();
  await expect(mode).toHaveCount(0);
  expect(music.snapshot().player.state).toBe('playing');
});

test('hides the controls while music plays and nothing moves', async ({ page }) => {
  const mode = await open(page);

  await mode.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(mode.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(mode).toHaveClass(/idle/, { timeout: 6000 });
  // Past the controls' fade.
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/listening-idle.png' });

  await page.mouse.move(300, 300);
  await expect(mode).not.toHaveClass(/idle/);
});

test('turns the record while playing, winds it down on pause, and spins it by hand', async ({
  page,
}) => {
  const mode = await open(page);
  const canvas = mode.locator('.tt canvas');
  // A hash of the frame's pixels, so a failure prints a number rather than a whole image.
  const frame = () =>
    canvas.evaluate((el: HTMLCanvasElement) => {
      const { data } = el.getContext('2d')!.getImageData(0, 0, el.width, el.height);
      let h = 0;

      for (let i = 0; i < data.length; i += 7) h = (Math.imul(h, 31) + data[i]!) | 0;

      return h;
    });

  const settled = async () => {
    const before = await frame();

    await page.waitForTimeout(300);

    return before === (await frame());
  };

  // Paused, it holds still once the sleeve's colours have faded in.
  await expect.poll(settled, { timeout: 20_000 }).toBe(true);

  const a = await frame();

  await mode.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(mode.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await frame()).not.toBe(a);

  await mode.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(mode.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  // Winding down, then still.
  expect(await settled()).toBe(false);
  await expect.poll(settled, { timeout: 20_000 }).toBe(true);

  const stopped = await frame();

  // A drag round the sleeve's corner turns it, playing or not.
  const box = (await canvas.boundingBox())!;

  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  expect(await frame()).not.toBe(stopped);
});

test('takes the keyboard while open, plays on Space, and closes on Escape', async ({ page }) => {
  const mode = await open(page);

  await expect(mode).toBeFocused();
  await page.keyboard.press('Space');
  await expect(mode.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

  // The screen underneath is inert, so Tab never leaves the dialog.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await mode.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(mode).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Full screen' })).toBeFocused();
});
