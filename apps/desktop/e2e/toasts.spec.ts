import { buildFromSearch, expect, test } from '../harness/fixture.js';
import type { ClaudeScript } from '../harness/server.js';

// Builds from the first search results, and suggests from what the draft left out.
const claude: ClaudeScript = async (turn) => {
  if (!turn.prompt.includes('Suggest up to')) return buildFromSearch()(turn);

  const { draft } = await turn.call('get_playlist_draft', { draft_id: turn.draftId });
  const taken = new Set(draft.entries.map((entry: { track_id: string }) => entry.track_id));
  const found = await turn.call('search', { limit: 30, compact: false });
  const picks = found.tracks
    .filter((track: { persistent_id: string }) => !taken.has(track.persistent_id))
    .slice(0, 4)
    .map((track: { persistent_id: string }) => ({
      track_id: track.persistent_id,
      reason: 'Fits.',
    }));

  turn.say(`Four that fit.\n${JSON.stringify({ picks })}`);
};

test.use({ claude: { script: claude } });

test('keeps the stack open while the pointer crosses from one toast to the next', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Warm-up');
  await page.getByRole('button', { name: 'Build it' }).click();

  const records = page.getByRole('list', { name: 'Draft order' }).getByRole('listitem');

  await expect(records).toHaveCount(8);
  await records.nth(3).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Replace…' }).click();

  const shortlist = page.getByRole('dialog', { name: /^Replace / });

  await expect(shortlist.getByRole('option')).toHaveCount(4);
  await shortlist.getByRole('button', { name: 'Swap in' }).click();
  await page.getByRole('button', { name: 'Save to Music' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();

  const toasts = page.locator('.toast');

  await expect(toasts).toHaveCount(2);
  await toasts.first().hover();
  // Let the stack fan out before measuring it.
  await page.waitForTimeout(600);

  const [newer, older] = await Promise.all([
    toasts.nth(0).boundingBox(),
    toasts.nth(1).boundingBox(),
  ]);

  // The newest sits at the bottom, so the gap runs from the older one's foot to its head.
  expect(newer!.y).toBeGreaterThan(older!.y + older!.height);

  for (let y = older!.y + older!.height - 2; y < newer!.y + 3; y++) {
    await page.mouse.move(newer!.x + 50, y);
    // Read at once: a retrying assertion would pass after the stack reopened under the pointer.
    await page.waitForTimeout(60);
    expect(await page.locator('.toasts.open').count(), `at y ${y}`).toBe(1);
  }
});
