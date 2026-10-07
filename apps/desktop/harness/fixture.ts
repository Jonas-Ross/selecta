import { test as base, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SelectaCache } from '@selecta/core/cache/index.js';
import { buildReadLibraryScript } from '@selecta/core/bridge/scripts/read_library.js';
import { camelotFor } from '@selecta/core/domain/camelot.js';
import type { LibrarySnapshot } from '@selecta/core/types/bridge.js';
import { fixtureTracks, type FixtureTrack } from './library.js';
import { MusicSim } from './music.js';
import { startSim, type ClaudeScript } from './server.js';

const app = fileURLToPath(new URL('..', import.meta.url));
const bin = fileURLToPath(new URL('./bin', import.meta.url));

export const buildFromSearch =
  (count = 8): ClaudeScript =>
  async ({ draftId, resumed, call, say }) => {
    if (resumed) return say('Nothing to change.');

    const found = await call('search', { limit: count, compact: false });

    say(`Here are ${count} records to start from.`);
    await call('show_playlist_draft', {
      draft_id: draftId,
      name: 'Harness set',
      track_ids: found.tracks.map((t: { persistent_id: string }) => t.persistent_id),
    });
  };

type Fixtures = {
  tracks: FixtureTrack[];
  music: MusicSim;
  // Wrapped, since Playwright would take a bare function for a fixture.
  claude: { script: ClaudeScript };
  home: string;
  electronApp: ElectronApplication;
  page: Page;
  actions: () => { method?: string; ok?: boolean; error?: string; [key: string]: unknown }[];
};

export const test = base.extend<Fixtures>({
  tracks: [fixtureTracks(), { option: true }],
  music: async ({ tracks }, use) => use(new MusicSim(tracks)),
  claude: [{ script: buildFromSearch() }, { option: true }],
  home: async ({ music, tracks }, use) => {
    const home = mkdtempSync(join(tmpdir(), 'selecta-harness-'));

    seed(join(home, 'Library/Application Support/Selecta/library.db'), music, tracks);
    await use(home);
  },
  electronApp: async ({ music, claude, home }, use) => {
    const sim = await startSim({ music, claude: claude.script, home });
    const electronApp = await _electron.launch({
      // Chromium won't run as root with its sandbox on.
      args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), app],
      cwd: app,
      env: {
        ...(process.env as Record<string, string>),
        HOME: home,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        SELECTA_SIM_URL: sim.url,
        SELECTA_CLAUDE_PATH: join(bin, 'claude'),
      },
    });

    await use(electronApp);
    await electronApp.close();
    await sim.close();
  },
  page: async ({ electronApp }, use) => use(await electronApp.firstWindow()),
  actions: async ({ home }, use) =>
    use(() => {
      try {
        return readFileSync(join(home, 'Library/Logs/Selecta/desktop.log'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    }),
});

export { expect } from '@playwright/test';

function seed(dbPath: string, music: MusicSim, tracks: FixtureTrack[]) {
  const cache = SelectaCache.open(dbPath);
  const snapshot = JSON.parse(music.run(buildReadLibraryScript())) as LibrarySnapshot;

  cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
  cache.saveAudioFeatures(
    tracks
      .filter((t) => t.bpm !== undefined)
      .map((t) => ({
        trackPersistentId: t.persistentId,
        bpm: t.bpm!,
        bpmConfidence: 0.9,
        bpmMaturity: 'validated',
        bpmWindowLow: null,
        bpmWindowHigh: null,
        musicalKey: t.musicalKey!,
        camelot: camelotFor(t.musicalKey),
        keyConfidence: 0.7,
        keyMaturity: 'provisional',
        danceability: null,
        sources: { bpm: 'metrognome@1', musicalKey: 'metrognome@1' },
        mbRecordingMbid: null,
        deezerTrackId: null,
        status: 'ok',
        catalogStatus: null,
        analysisStatus: 'ok',
        fetchedAt: '2026-10-01T00:00:00.000Z',
      })),
  );
  cache.close();
}
