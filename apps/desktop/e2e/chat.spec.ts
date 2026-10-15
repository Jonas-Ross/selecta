import { expect, test } from '../harness/fixture.js';

const REPLY = [
  'Here are some sillier ones, still numbered on from before:',
  '',
  '13. **My Neighbors Have Filed a Complaint**',
  '14. **Cardio I Did Not Consent To**',
  '15. **145 BPM and a Dream**, after `Scream!`',
  '',
  'Openers to try:',
  '- *Pressure Drop*',
  '- [Afterburner](https://example.com/afterburner)',
  '',
  "The name is still **Redline**. Pick a number and I'll change it. <b>raw</b>",
].join('\n');

test.use({
  claude: {
    script: async ({ draftId, call, say }) => {
      const found = await call('search', { limit: 6, compact: false });

      await call('show_playlist_draft', {
        draft_id: draftId,
        name: 'Redline',
        track_ids: found.tracks.map((t: { persistent_id: string }) => t.persistent_id),
      });
      say(REPLY);
    },
  },
});

test('formats an agent reply as Markdown, links opening outside the app', async ({
  electronApp,
  page,
}) => {
  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Something absurd for the gym');
  await page.getByRole('button', { name: 'Build it' }).click();

  const at = page.url();
  const reply = page.getByRole('complementary').locator('.msg.claude').last();

  await expect(reply.getByRole('strong').first()).toHaveText('My Neighbors Have Filed a Complaint');
  await expect(reply.locator('ol')).toHaveAttribute('start', '13');
  await expect(reply.locator('code')).toHaveText('Scream!');
  await expect(reply.locator('em')).toHaveText('Pressure Drop');
  // Raw HTML stays text.
  await expect(reply.locator('b')).toHaveCount(0);
  await expect(reply).toContainText('<b>raw</b>');
  await page.screenshot({ path: 'test-results/chat-markdown.png' });

  await electronApp.evaluate(({ shell }) => {
    const opened: string[] = [];

    (globalThis as { opened?: string[] }).opened = opened;
    shell.openExternal = async (url: string) => void opened.push(url);
  });
  await reply.getByRole('link', { name: 'Afterburner' }).click();
  await expect
    .poll(() => electronApp.evaluate(() => (globalThis as { opened?: string[] }).opened))
    .toEqual(['https://example.com/afterburner']);
  expect(electronApp.windows()).toHaveLength(1);
  expect(page.url()).toBe(at);
});
