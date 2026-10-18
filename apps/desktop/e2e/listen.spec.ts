import type { Page } from '@playwright/test';
import { buildFromSearch, expect, test } from '../harness/fixture.js';
import { fixtureTracks } from '../harness/library.js';

const preview = (music: { snapshot: () => { playlists: { name: string; tracks: string[] }[] } }) =>
  music.snapshot().playlists.find((pl) => pl.name === 'Selecta Preview')?.tracks;

async function build(page: Page) {
  await page.getByRole('button', { name: 'New playlist' }).first().click();
  await page.getByLabel('The brief').fill('Warm-up, nothing too loud');
  await page.getByRole('button', { name: 'Build it' }).click();
  await expect(page.getByRole('list', { name: 'Draft order' }).getByRole('listitem')).toHaveCount(
    8,
  );
}

test('plays the draft through Selecta Preview, follows Music on, and keeps it in step with a reorder', async ({
  page,
  music,
  tracks,
  actions,
}) => {
  await build(page);
  await page.getByRole('tab', { name: 'Listen' }).click();
  await page.getByRole('button', { name: 'Play' }).click();

  const playing = page.locator('[role=listitem][aria-current=true]');
  const records = page.getByRole('list', { name: 'Draft order' }).getByRole('listitem');

  await expect(playing).toHaveCount(1);
  await expect(page.getByText(/agent waits/i)).toHaveCount(0);
  await expect(records.first()).toHaveAttribute('aria-current', 'true');
  await expect
    .poll(() => music.snapshot().player)
    .toMatchObject({
      state: 'playing',
      playlist: 'Selecta Preview',
      index: 1,
    });

  const first = tracks.find((t) => t.persistentId === preview(music)![0])!;

  music.advance(first.duration);
  await expect(records.nth(1)).toHaveAttribute('aria-current', 'true');

  const before = preview(music)!;

  await records.nth(4).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect
    .poll(() => preview(music))
    .toEqual([...before.slice(0, 3), before[4], before[3], ...before.slice(5)]);
  await expect(records.nth(1)).toHaveAttribute('aria-current', 'true');

  await page.screenshot({ path: 'test-results/listen.png' });
  expect(actions().filter((a) => a.method?.startsWith('player.') && a.error)).toEqual([]);
});

test('answers at once while Music is slow, and plays only where the last click leads', async ({
  page,
  music,
  actions,
}) => {
  await build(page);
  await page.getByRole('tab', { name: 'Listen' }).click();

  const records = page.getByRole('list', { name: 'Draft order' }).getByRole('listitem');
  const transport = page.locator('footer.transport');
  const release = music.hold();

  await page.getByRole('button', { name: 'Play' }).click();
  // The bar shows the play straight away, marked as not yet confirmed.
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(transport).toHaveAttribute('aria-busy', 'true');
  await expect(records.first()).toHaveAttribute('aria-current', 'true');

  // Clicks keep landing while the first play waits on Music, and fold into one step.
  await page.getByRole('button', { name: 'Next record' }).click();
  await page.getByRole('button', { name: 'Next record' }).click();
  await page.getByRole('button', { name: 'Previous record' }).click();
  await expect(records.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText('Waiting for Music.app')).toHaveCount(0);
  expect(music.snapshot().player.state).toBe('stopped');

  release();
  await expect.poll(() => music.snapshot().player).toMatchObject({ state: 'playing', index: 2 });
  await expect(transport).toHaveAttribute('aria-busy', 'false');
  await expect(records.nth(1)).toHaveAttribute('aria-current', 'true');
  expect(music.calls.filter((c) => c === 'next' || c === 'previous')).toEqual(['next']);

  // A pause behind a play still in flight lands after it, leaving Music paused.
  const again = music.hold();

  await page.getByRole('button', { name: 'Next record' }).click();
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  again();
  await expect.poll(() => music.snapshot().player.state).toBe('paused');
  await expect(transport).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();

  // The rail stays free while Music is held, and the preview catches up once it answers.
  const before = preview(music)!;
  const third = await records.nth(4).textContent();
  const later = music.hold();

  await records.nth(4).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(records.nth(3)).toHaveText(third!);
  await expect(page.getByText(/old copy of this draft/)).toHaveCount(0);
  expect(preview(music)).toEqual(before);
  later();
  await expect
    .poll(() => preview(music))
    .toEqual([...before.slice(0, 3), before[4], before[3], ...before.slice(5)]);
  await expect(page.getByText(/old copy of this draft/)).toHaveCount(0);
  expect(actions().filter((a) => a.method?.startsWith('player.') && a.error)).toEqual([]);
});

test('says why when shuffle is on in Music, and plays nothing', async ({ page, music }) => {
  music.shuffle = true;
  await build(page);
  await page.getByRole('tab', { name: 'Listen' }).click();
  await page.getByRole('button', { name: 'Play' }).click();

  await expect(page.getByText(/Shuffle is on/).first()).toBeVisible();
  expect(music.snapshot().player.state).toBe('stopped');
});

test.describe('when Claude reaches for a write the app never allows', () => {
  test.use({
    claude: {
      script: async ({ draftId, call }) => {
        await call('save_playlist_draft', { draft_id: draftId, revision: 1 });
      },
    },
  });

  test('shows the refusal', async ({ page }) => {
    await page.getByRole('button', { name: 'New playlist' }).first().click();
    await page.getByLabel('The brief').fill('Save it straight away');
    await page.getByRole('button', { name: 'Build it' }).click();

    await expect(
      page.getByText('save_playlist_draft is not allowed for the in-app agent.'),
    ).toBeVisible();
  });
});

test.describe('with every record measured', () => {
  // The swell runs only on a record with a tempo, and the fixture leaves every fifth unmeasured.
  // An array value would read as Playwright's [value, options] pair, so it's wrapped as one.
  test.use({
    tracks: [fixtureTracks().map((track) => ({ bpm: 120, ...track })), { scope: 'test' }],
  });

  test('swells the glow on the bar Music is at, and moves the bar line when Music jumps', async ({
    page,
    music,
  }) => {
    await build(page);
    await page.getByRole('tab', { name: 'Listen' }).click();
    await page.getByRole('button', { name: 'Play' }).click();

    // Where the glow's swell puts the record, in seconds, against where Music is.
    const drift = () =>
      page.locator('.deck-glow').evaluate((el) => {
        // The glow's fade in is a transition, which isn't the swell.
        const pulse = el.getAnimations().find((a) => !(a instanceof CSSTransition));
        const now = document.timeline.currentTime as number;

        return pulse ? (now - Number(pulse.startTime)) / 1000 : undefined;
      });
    const near = async () => {
      const at = await drift();

      return at !== undefined && Math.abs(at - music.snapshot().player.position) < 1.5;
    };

    await expect.poll(near).toBe(true);
    music.advance(60);
    await expect.poll(near).toBe(true);

    await page.getByRole('button', { name: 'Pause' }).click();
    await expect.poll(drift).toBeUndefined();
  });
});

test.describe('when feedback arrives while the draft plays', () => {
  test.use({
    claude: {
      script: async (turn) => {
        if (!turn.resumed) return buildFromSearch()(turn);

        const { draft } = await turn.call('get_playlist_draft', { draft_id: turn.draftId });

        await turn.call('edit_playlist_draft', {
          draft_id: turn.draftId,
          revision: draft.revision,
          entries: draft.entries
            .slice(0, -1)
            .map(({ entry_id, track_id }: Record<string, string>) => ({ entry_id, track_id })),
        });
        turn.say('Dropped the last one.');
      },
    },
  });

  test('stops the music and lets the agent edit', async ({ page, music }) => {
    await build(page);
    await page.getByRole('tab', { name: 'Listen' }).click();
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.locator('[role=listitem][aria-current=true]')).toHaveCount(1);

    const panel = page.getByRole('complementary', { name: 'Claude' });

    await panel.getByLabel('Message to Claude').fill('Too close to that playlist');
    await expect(panel.getByText(/Sending stops the music/)).toBeVisible();
    await page.screenshot({ path: 'test-results/send-while-listening.png' });
    await panel.getByRole('button', { name: 'Send' }).click();

    await expect(panel.getByText('Dropped the last one.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Draft order' }).getByRole('listitem')).toHaveCount(
      7,
    );
    await expect(panel.getByText(/can't edit this draft/)).toHaveCount(0);
    expect(music.snapshot().player.state).toBe('paused');
  });
});

test('crossfades between Dig and Listen with the crate kept and the rail held still', async ({
  page,
  electronApp,
}) => {
  // Tall enough that the band reaches its cap, where the two used to differ by 90px.
  await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setSize(2048, 1280),
  );
  await build(page);

  const crate = page.locator('.crate-stage .sl');

  await expect(crate.first()).toBeAttached();

  const railTop = () =>
    page.evaluate(() => document.querySelector('.rail-area')!.getBoundingClientRect().top);
  const before = await railTop();

  for (const tab of ['Listen', 'Dig']) {
    // The frame after the click, before any fetch could land.
    const next = await page.evaluate(
      (name) =>
        new Promise<{ records: number; railTop: number }>((resolve) => {
          [...document.querySelectorAll<HTMLElement>('[role=tab]')]
            .find((el) => el.textContent === name)!
            .click();
          requestAnimationFrame(() =>
            resolve({
              records: document.querySelectorAll('.crate-stage .sl').length,
              railTop: document.querySelector('.rail-area')!.getBoundingClientRect().top,
            }),
          );
        }),
      tab,
    );

    expect(next.records).toBeGreaterThan(0);
    expect(next.railTop).toBe(before);
  }

  await expect(page.getByRole('region', { name: 'The crate' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Listen' })).toBeHidden();
  // Flush with the draft, not nudged by another rule sharing its class name.
  expect(
    await page.evaluate(() => {
      const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();

      return [box('.mode-band').left, box('.mode-band').right];
    }),
  ).toEqual(
    await page.evaluate(() => {
      const box = document.querySelector('.draft-main')!.getBoundingClientRect();

      return [box.left, box.right];
    }),
  );
});
