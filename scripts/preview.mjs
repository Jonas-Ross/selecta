// Development-only fixture host. Never imports the live Music.app bridge or
// opens the user's cache. The production bundle runs inside a standard iframe.
import { createServer } from 'node:http';
import { readFile, readdir, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { CallToolRequestParamsSchema } from '@modelcontextprotocol/sdk/types.js';
import { SelectaCache } from '../dist/cache/index.js';
import { DraftStore } from '../dist/drafts/store.js';
import { handleLibraryExplorer } from '../dist/tools/library_explorer.js';
import { PlaylistDraftTools } from '../dist/tools/playlist_draft.js';

const root = new URL('../', import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'selecta-preview-'));
const caches = { draft: SelectaCache.open(':memory:'), explorer: SelectaCache.open(':memory:') };
const resources = { draft: 'playlist-draft', explorer: 'library-explorer' };
const ResetInput = z.strictObject({ scenario: z.string() });
const fixture = JSON.parse(
  await readFile(new URL('../test/fixtures/library.json', import.meta.url), 'utf8'),
);

const handlers = new PlaylistDraftTools({
  cache: () => caches.draft,
  bridge: {
    createPlaylist: async ({ trackIds }) => ({
      persistentId: `PREVIEW-${randomUUID()}`,
      trackCount: trackIds.length,
      trackPersistentIds: trackIds,
    }),
  },
  drafts: () => new DraftStore(join(directory, 'drafts.db')),
});
let draftId;
const TRACK_IDS = ['T-TEARDROP', 'T-ANGEL', 'T-GLORYBOX', 'T-ROADS', 'T-MIDNIGHT', 'T-TEARDROP'];
// One record per fixture: the page lists them, /reset loads one by key.
const standard = { label: 'Repeated tracks', name: 'After the last train', trackIds: TRACK_IDS };
const scenarios = {
  explorer: {
    standard: { label: 'Library slices', count: 156 },
    missing: { label: 'Missing metadata', count: 30, missing: true },
    long: { label: '1,000 tracks / 65 genres', count: 1000, genres: true },
    empty: { label: 'Empty library', count: 0 },
  },
  draft: {
    standard,
    missing: {
      ...standard,
      label: 'Missing duration',
      snapshot: (snapshot) => {
        delete snapshot.tracks.find((track) => track.persistentId === 'T-ANGEL').durationSeconds;
      },
    },
    long: {
      label: '500 entries',
      name: 'The very last train (500 entries)',
      trackIds: Array.from({ length: 500 }, (_, i) => TRACK_IDS[i % TRACK_IDS.length]),
    },
  },
};

async function reset(widget, key) {
  const scenario = scenarios[widget][key];
  const cache = caches[widget];
  const snapshot = structuredClone(fixture);

  if (widget === 'explorer') {
    const capturedAt = Date.now();

    snapshot.capturedAt = new Date(capturedAt).toISOString();
    snapshot.tracks = Array.from({ length: scenario.count }, (_, i) => {
      const original = fixture.tracks[i % fixture.tracks.length];
      const row = {
        ...original,
        persistentId: `E-${i}`,
        playCount: i % 4 === 0 ? 0 : i % 53,
        dateAdded: new Date(capturedAt - (i % 90) * 86_400_000).toISOString(),
        year: 1970 + ((i * 7) % 57),
      };

      if (scenario.genres) row.genre = `Raw genre ${i % 65}`;

      if (scenario.missing || i % 17 === 0) {
        delete row.genre;
        delete row.year;
        delete row.durationSeconds;
      }

      return row;
    });
    snapshot.playlists = [];
    cache.refreshFromSnapshot(snapshot, { durationMs: 1 });

    return;
  }

  scenario.snapshot?.(snapshot);
  cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
  // Synthetic feature values for UI verification, never fetched or written live.
  cache.saveAudioFeatures([
    {
      trackPersistentId: 'T-TEARDROP',
      bpm: 76,
      musicalKey: 'A minor',
      danceability: null,
      sources: { bpm: 'fixture', musicalKey: 'fixture' },
      mbRecordingMbid: null,
      deezerTrackId: null,
      status: 'ok',
      fetchedAt: fixture.capturedAt,
    },
  ]);
  draftId = randomUUID();
  await handlers.show({ draft_id: draftId, name: scenario.name, track_ids: scenario.trackIds });
}

await reset('draft', 'standard');
await reset('explorer', 'standard');
const port = Number(process.env.SELECTA_PREVIEW_PORT ?? 8767);
const origin = `http://127.0.0.1:${port}`;
const files = (await readdir(new URL('ui/', root))).map((file) => `ui/${file}`);
const version = async () =>
  (await Promise.all(files.map(async (file) => (await stat(new URL(file, root))).mtimeMs))).join(
    '-',
  );
// Both iframes request their bundles together. Share the build so one request
// cannot read an output while another build is still writing it.
let building;

function buildWidgets() {
  building ??= promisify(execFile)(process.execPath, ['scripts/build-ui.mjs'], {
    cwd: root,
  }).finally(() => {
    building = undefined;
  });

  return building;
}

const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(403).end();

      return;
    }

    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'POST') {
      if (req.headers.origin !== origin) {
        res.writeHead(403).end();

        return;
      }

      let body = '';

      for await (const chunk of req) {
        body += chunk;

        if (body.length > 100_000) {
          res.writeHead(413).end();

          return;
        }
      }

      res.setHeader('Content-Type', 'application/json');

      const route = /^\/(reset|call)\/(draft|explorer)$/.exec(req.url);

      if (!route) {
        res.writeHead(404).end();

        return;
      }

      const [, operation, widget] = route;
      const cache = caches[widget];
      let input;

      try {
        input = (operation === 'reset' ? ResetInput : CallToolRequestParamsSchema).parse(
          JSON.parse(body),
        );
      } catch {
        res.writeHead(400).end();

        return;
      }

      if (operation === 'reset') {
        if (!Object.hasOwn(scenarios[widget], input.scenario)) {
          res.writeHead(400).end();

          return;
        }

        await reset(widget, input.scenario);
        res.end(JSON.stringify(widget === 'draft' ? { draft_id: draftId } : {}));

        return;
      }

      const { name, arguments: args } = input;

      if (widget === 'explorer') {
        let value;

        if (name === 'show_library_explorer')
          value = await handleLibraryExplorer(args, { cache: () => cache });
        else if (name === 'refresh_library')
          value = {
            track_count: cache.getOverview({}).totalTracks,
            playlist_count: 0,
            refreshed_at: new Date().toISOString(),
          };
        else {
          res.writeHead(400).end();

          return;
        }

        res.end(
          JSON.stringify({
            content: [{ type: 'text', text: JSON.stringify(value) }],
            structuredContent: value,
            isError: !!value.error,
          }),
        );

        return;
      }

      const method = {
        playlist_draft_appearance: 'appearance',
        get_playlist_draft: 'get',
        edit_playlist_draft: 'edit',
        save_playlist_draft: 'save',
      }[name];

      if (!method) {
        res.writeHead(400).end();

        return;
      }

      const value = await handlers[method](args);

      res.end(
        JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
          isError: !!value.error,
        }),
      );

      return;
    }

    if (req.url === '/version') {
      res.end(await version());

      return;
    }

    const url = new URL(req.url, origin);

    const widget = Object.keys(resources).find((key) => url.pathname === `/widget/${key}`);

    if (widget) {
      await buildWidgets();
      res.setHeader('Content-Type', 'text/html');
      let widgetHtml = await readFile(
        new URL(`../dist/ui/${resources[widget]}.html`, import.meta.url),
        'utf8',
      );

      if (url.searchParams.get('host') === 'codex') {
        // Representative conflicting renderer rules, not a copy of host CSS.
        widgetHtml = widgetHtml.replace(
          '</head>',
          `<style>
          :root { --accent: #223344; --muted: #777777; background: #111111 !important; }
          html > body { padding: 0; color: #777777; background: transparent !important; }
          button, select, textarea { background: #000000; color: #777777; }
        </style></head>`,
        );
      }

      res.end(widgetHtml);

      return;
    }

    if (req.url !== '/') {
      res.writeHead(404).end();

      return;
    }

    const html = await readFile(new URL('../ui/preview.html', import.meta.url), 'utf8');

    const options = (widget) =>
      Object.entries(scenarios[widget])
        .map(([key, { label }]) => `<option value="${key}">${label}</option>`)
        .join('');

    res.setHeader('Content-Type', 'text/html');
    res.end(
      html
        .replace('__DRAFT_ID__', draftId)
        .replace('<!--__DRAFT_SCENARIOS__-->', options('draft'))
        .replace('<!--__EXPLORER_SCENARIOS__-->', options('explorer')),
    );
  } catch (error) {
    console.error(error);
    res.writeHead(500).end('Preview request failed. See terminal.');
  }
});

server.listen(port, '127.0.0.1', () =>
  console.log(
    `Selecta design preview: ${origin}\nFixture data only. UI edits reload automatically. Ctrl+C to stop.`,
  ),
);

for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () =>
    server.close(async () => {
      for (const cache of Object.values(caches)) cache.close();

      await rm(directory, { recursive: true, force: true });
      process.exit(0);
    }),
  );
