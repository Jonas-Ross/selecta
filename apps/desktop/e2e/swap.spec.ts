import { expect, test } from '../harness/fixture.js';
import type { Turn } from '../harness/server.js';

const turns: Pick<Turn, 'provider' | 'prompt' | 'resumed'>[] = [];

test.use({
  claude: {
    script: async ({ provider, prompt, resumed, draftId, call, say }) => {
      turns.push({ provider, prompt, resumed });

      if (provider === 'claude') {
        const found = await call('search', { limit: 6, compact: false });

        say('Six records to start.');
        await call('show_playlist_draft', {
          draft_id: draftId,
          name: 'Harness set',
          track_ids: found.tracks.map((t: { persistent_id: string }) => t.persistent_id),
        });

        return;
      }

      const { draft } = await call('get_playlist_draft', { draft_id: draftId });

      await call('edit_playlist_draft', {
        draft_id: draftId,
        revision: draft.revision,
        entries: draft.entries
          .slice(0, -1)
          .map(({ entry_id, track_id }: Record<string, string>) => ({ entry_id, track_id })),
      });
      say('Dropped the last one.');
    },
  },
});

test('hands a built draft to Codex, which picks up the brief and the draft as they stand', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Warm-up, nothing too loud');
  await page.getByRole('radio', { name: 'Claude' }).check();
  await page.getByRole('button', { name: 'Build it' }).click();

  const records = page.getByRole('list', { name: 'Draft order' }).getByRole('listitem');
  const panel = page.getByRole('complementary');

  await expect(records).toHaveCount(6);
  await page.screenshot({ path: 'test-results/swap-before.png' });

  await panel.getByRole('radio', { name: 'Codex' }).check();
  await panel.getByRole('textbox').fill('One fewer');
  await panel.getByRole('textbox').press('Enter');
  await expect(records).toHaveCount(5);
  await expect(panel.getByText('Dropped the last one.')).toBeVisible();
  // Each reply keeps the name of the agent that wrote it.
  await expect(panel.locator('.msg.claude .who')).toHaveText(['Claude', 'Codex']);
  await page.screenshot({ path: 'test-results/swap-after.png' });

  expect(turns.map((turn) => [turn.provider, turn.resumed])).toEqual([
    ['claude', false],
    ['codex', false],
  ]);
  expect(turns[1]!.prompt).toContain('Earlier requests on this draft');
  expect(turns[1]!.prompt).toContain('Warm-up, nothing too loud');
});
