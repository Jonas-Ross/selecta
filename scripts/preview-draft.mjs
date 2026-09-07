// Development-only fixture host. Never imports the live Music.app bridge or
// opens the user's cache. The production bundle runs inside a standard iframe.
import { createServer } from 'node:http';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SelectaCache } from '../dist/cache/index.js';
import { DraftStore } from '../dist/drafts/store.js';
import { PlaylistDraftTools } from '../dist/tools/playlist_draft.js';

const root = new URL('../', import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'selecta-preview-'));
const cache = SelectaCache.open(':memory:');
const fixture = JSON.parse(
  await readFile(new URL('../test/fixtures/library.json', import.meta.url), 'utf8'),
);

cache.refreshFromSnapshot(fixture, { durationMs: 1 });
const handlers = new PlaylistDraftTools(
  {
    cache: () => cache,
    bridge: {
      createPlaylist: async ({ trackIds }) => ({
        persistentId: `PREVIEW-${randomUUID()}`,
        trackCount: trackIds.length,
        trackPersistentIds: trackIds,
      }),
    },
  },
  new DraftStore(join(directory, 'drafts.db')),
);
let draftId;

async function reset() {
  draftId = randomUUID();
  await handlers.show({
    draft_id: draftId,
    name: 'After the last train',
    track_ids: ['T-TEARDROP', 'T-ANGEL', 'T-GLORYBOX', 'T-ROADS', 'T-MIDNIGHT', 'T-TEARDROP'],
  });
}

await reset();
const port = Number(process.env.SELECTA_PREVIEW_PORT ?? 8766);
const origin = `http://127.0.0.1:${port}`;
const files = [
  'ui/playlist-draft.html',
  'ui/playlist-draft.js',
  'ui/pulse.css',
  'ui/pulse.js',
  'ui/dom.js',
];
const version = async () =>
  (await Promise.all(files.map(async (file) => (await stat(new URL(file, root))).mtimeMs))).join(
    '-',
  );
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

      if (req.url === '/reset') {
        await reset();
        res.end(JSON.stringify({ draft_id: draftId }));

        return;
      }

      if (req.url !== '/call') {
        res.writeHead(404).end();

        return;
      }

      const { name, arguments: args } = JSON.parse(body);
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

    if (url.pathname === '/widget') {
      await promisify(execFile)(process.execPath, ['scripts/build-ui.mjs'], { cwd: root });
      res.setHeader('Content-Type', 'text/html');
      let widget = await readFile(
        new URL('../dist/ui/playlist-draft.html', import.meta.url),
        'utf8',
      );

      if (url.searchParams.get('host') === 'codex') {
        // Representative conflicting renderer rules, not a copy of host CSS.
        widget = widget.replace(
          '</head>',
          `<style>
          :root { --accent: #223344; --muted: #777777; background: #111111 !important; }
          html > body { padding: 0; color: #777777; background: transparent !important; }
          button, select, textarea { background: #000000; color: #777777; }
        </style></head>`,
        );
      }

      res.end(widget);

      return;
    }

    if (req.url !== '/') {
      res.writeHead(404).end();

      return;
    }

    const html = await readFile(new URL('../ui/preview.html', import.meta.url), 'utf8');

    res.setHeader('Content-Type', 'text/html');
    res.end(html.replace('__DRAFT_ID__', draftId));
  } catch (error) {
    console.error(error);
    res.writeHead(500).end('Preview request failed. See terminal.');
  }
});

server.listen(port, '127.0.0.1', () =>
  console.log(
    `Draft design preview: ${origin}\nFixture data only. UI edits reload automatically. Ctrl+C to stop.`,
  ),
);

for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () =>
    server.close(async () => {
      cache.close();
      await rm(directory, { recursive: true, force: true });
      process.exit(0);
    }),
  );
