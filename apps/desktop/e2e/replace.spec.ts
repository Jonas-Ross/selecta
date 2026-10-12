import type { Page } from '@playwright/test';
import { buildFromSearch, expect, test } from '../harness/fixture.js';
import type { ClaudeScript } from '../harness/server.js';

const preview = (music: { snapshot: () => { playlists: { name: string; tracks: string[] }[] } }) =>
  music.snapshot().playlists.find((pl) => pl.name === 'Selecta Preview')?.tracks;

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
      reason: 'Close to both neighbours in tempo, and a key next door on the wheel.',
    }));

  turn.say(`Four that fit.\n${JSON.stringify({ picks })}`);
};

test.use({ claude: { script: claude } });

async function build(page: Page) {
  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Warm-up, nothing too loud');
  await page.getByRole('button', { name: 'Build it' }).click();
  await expect(page.getByRole('list', { name: 'Draft order' }).getByRole('listitem')).toHaveCount(
    8,
  );
}

test('replaces a record from the shortlist or the bench, after hearing it in place', async ({
  page,
  music,
  actions,
}) => {
  await build(page);

  const records = page.getByRole('list', { name: 'Draft order' }).getByRole('listitem');
  const order = () =>
    records.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label')));
  const before = await order();

  // Sleeves fade their art in; let it land before the picture.
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/replace-before.png' });

  await records.nth(3).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Replace…' })).toBeFocused();
  await page.screenshot({ path: 'test-results/replace-menu.png' });
  await page.getByRole('menuitem', { name: 'Replace…' }).click();

  const shortlist = page.getByRole('dialog', { name: /^Replace / });
  const picks = shortlist.getByRole('option');

  await expect(picks).toHaveCount(4);
  await expect(picks.first()).toHaveAttribute('aria-selected', 'true');
  await expect(shortlist.getByText('Close to both neighbours')).toBeVisible();
  // Sleeves fade their art in; let it land before the picture.
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/replace-shortlist.png' });

  // Hear it plays the pick between the records either side of it, so the joins play too.
  await shortlist.getByRole('button', { name: 'Hear it' }).click();
  await expect.poll(() => preview(music)?.length).toBe(3);
  expect(music.snapshot().player).toMatchObject({
    state: 'playing',
    playlist: 'Selecta Preview',
    index: 2,
  });
  await expect(shortlist.getByRole('button', { name: 'Pause' })).toBeVisible();

  // The second pick, up close.
  await picks.nth(1).click();

  const title = (await picks.nth(1).locator('.cand-t b').textContent())!;

  await picks.nth(1).getByRole('button', { name: 'Close-up' }).click();

  const bench = page.getByRole('dialog', { name: /^Replace / });

  await expect(bench.getByRole('heading', { name: title })).toBeVisible();
  await expect(bench.getByRole('button', { name: 'Hear the way in' })).toBeEnabled();
  // Sleeves fade their art in; let it land before the picture.
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/replace-bench.png' });

  await bench.getByRole('button', { name: 'Swap in' }).click();
  await expect(bench).toBeHidden();
  await expect(records.nth(3)).toHaveAttribute('aria-label', new RegExp(`^4 of 8: ${title} by`));
  await expect(page.getByRole('status').filter({ hasText: /^Swapped .* for / })).toBeVisible();
  // Closing paused the audition rather than leaving it playing.
  await expect.poll(() => music.snapshot().player.state).toBe('paused');
  // Sleeves fade their art in; let it land before the picture.
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/replace-after.png' });

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(order).toEqual(before);

  expect(actions().filter((a) => a.error)).toEqual([]);
});

test('opens from the keyboard and closes with Escape, leaving the draft as it was', async ({
  page,
}) => {
  await build(page);

  const records = page.getByRole('list', { name: 'Draft order' }).getByRole('listitem');

  await records.nth(0).focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Replace…' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: /^Replace / }).getByRole('option')).toHaveCount(4);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /^Replace / })).toBeHidden();
  await expect(page.getByText('Replacing a record')).toBeHidden();
});
