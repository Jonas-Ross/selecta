import type { Page } from '@playwright/test';
import { expect, test } from '../harness/fixture.js';
import { hears } from '../harness/metrognome.js';

async function build(page: Page) {
  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Warm-up, nothing too loud');
  await page.getByRole('button', { name: 'Build it' }).click();
  await expect(page.getByRole('list', { name: 'Draft order' }).getByRole('listitem')).toHaveCount(
    8,
  );
}

/** The blank lanes' measure buttons, two per unmeasured record. */
const measureButtons = (page: Page) =>
  page.locator('.slot-labels').getByRole('button', { name: /^Measure / });

// Holds metrognome's answer until the test has seen the record measuring.
let listening: Promise<void>;
let release: () => void;

test.beforeEach(() => {
  listening = new Promise((resolve) => (release = resolve));
});

test.use({
  metrognome: {
    script: async (query) => {
      await listening;

      return hears(126, 'A minor', '8A')(query);
    },
  },
});

test('measures an unmeasured record from the rail and shows what it heard', async ({ page }) => {
  await build(page);

  const buttons = measureButtons(page);
  const before = await buttons.count();

  expect(before).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: 'test-results/measure-before.png' });

  const name = (await buttons.first().getAttribute('aria-label'))!.replace('Measure ', '');

  await buttons.first().click();

  // Both of its blank lanes wait on the one measurement.
  await expect(page.locator('.slot-labels').getByRole('status')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/measure-busy.png' });
  release();

  await expect(buttons).toHaveCount(before - 2);
  await expect(
    page.getByRole('listitem', { name: new RegExp(`${name} by .*126 BPM, 8A`) }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/measure-after.png' });
});

test.describe('when the key is too unsure to keep', () => {
  test.use({ metrognome: { script: hears(126, 'A minor', '8A', { keyUnsure: true }) } });

  test('keeps the tempo, leaves the key blank and says why', async ({ page }) => {
    await build(page);

    const buttons = measureButtons(page);
    const before = await buttons.count();

    await buttons.first().click();

    await expect(page.locator('.slot-labels').getByRole('button', { name: 'unsure' })).toHaveCount(
      1,
    );
    await expect(buttons).toHaveCount(before - 2);
    await page.locator('.slot-labels').getByRole('button', { name: 'unsure' }).hover();
    await expect(page.getByRole('tooltip')).toContainText('wasn’t sure enough');
    await page.screenshot({ path: 'test-results/measure-unsure.png' });
  });
});
