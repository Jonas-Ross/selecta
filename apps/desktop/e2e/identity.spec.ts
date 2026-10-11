import { readFileSync } from 'node:fs';
import { expect, test } from '../harness/fixture.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('names itself Selecta and points Help at Selecta, not Electron', async ({
  electronApp,
  page,
}) => {
  await expect(page).toHaveTitle('Selecta');

  const identity = await electronApp.evaluate(({ app, Menu }) => {
    const labels = (items: Electron.MenuItem[]): string[] =>
      items.flatMap((item) => [item.label, ...labels(item.submenu?.items ?? [])]);

    return {
      name: app.getName(),
      version: app.getVersion(),
      labels: labels(Menu.getApplicationMenu()?.items ?? []),
    };
  });

  expect(identity.name).toBe('Selecta');
  expect(identity.version).toBe(pkg.version);
  expect(identity.labels).toEqual(expect.arrayContaining(['Selecta Website', 'Report a Problem']));
  expect(identity.labels.filter((label) => /electron/i.test(label))).toEqual([]);
});
