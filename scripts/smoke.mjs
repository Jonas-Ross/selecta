#!/usr/bin/env node
// End-to-end smoke (docs/design.md §Testing): one scripted scenario against the
// REAL library over real MCP stdio — refresh → search → get_track_context →
// preview_playlist → create_playlist — then deletes the created playlist so the
// only trace left is the (by-design) "Selecta Preview" slot. Not part of the
// test suite: run with `npm run smoke` and eyeball the output.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SMOKE_PLAYLIST = 'Selecta Smoke Test';
const root = dirname(dirname(fileURLToPath(import.meta.url)));

const step = (name) => process.stdout.write(`\n=== ${name}\n`);
const fail = (msg) => {
  console.error(`SMOKE FAILED: ${msg}`);
  process.exit(1);
};

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const body = JSON.parse(result.content[0].text);
  if (result.isError) fail(`${name} → ${body.error}: ${body.hint}`);
  return body;
}

const client = new Client({ name: 'selecta-smoke', version: '0.1.0' });
await client.connect(
  new StdioClientTransport({ command: 'node', args: [join(root, 'dist/index.js')] }),
);

step('tools/list');
const { tools } = await client.listTools();
console.log(tools.map((t) => t.name).join(', '));
if (tools.length !== 7) fail(`expected 7 tools, got ${tools.length}`);

step('refresh_library (full reread — takes a moment)');
const refresh = await call(client, 'refresh_library', {});
console.log(JSON.stringify(refresh));

step('library_overview: whole library, then a loved slice');
const overview = await call(client, 'library_overview', {});
// The unfiltered aggregate scan must agree with the snapshot just written.
if (overview.total_tracks !== refresh.track_count) {
  fail(`overview total_tracks ${overview.total_tracks} != refresh track_count ${refresh.track_count}`);
}
console.log(
  `${overview.total_tracks} tracks, ${overview.total_runtime_human}, ${overview.artists_total} artists; ` +
    `top genres: ${overview.genres
      .slice(0, 3)
      .map((g) => `${g.name} (${g.count})`)
      .join(', ')}`,
);
const lovedOverview = await call(client, 'library_overview', { loved: true });
if (!lovedOverview.filtered || lovedOverview.total_tracks > overview.total_tracks) {
  fail(`loved slice (${lovedOverview.total_tracks}, filtered=${lovedOverview.filtered}) inconsistent with whole library (${overview.total_tracks})`);
}
console.log(`loved slice: ${lovedOverview.total_tracks} tracks`);

step('search: most-played favorited tracks');
const search = await call(client, 'search', { loved: true, limit: 5 });
if (search.tracks.length === 0) fail('no favorited tracks found — empty library?');
const seed = search.tracks[0];
console.log(`seed: "${seed.title}" — ${seed.artist} (${seed.signal.play_count} plays)`);

step(`get_track_context: ${seed.title}`);
const ctx = await call(client, 'get_track_context', { track_id: seed.persistent_id });
console.log(
  `same_artist: ${ctx.same_artist.length}, in_playlists: ${ctx.appearing_in_playlists.length}, co_occurring: ${ctx.co_occurring_tracks.length}`,
);

// Tracklist: the seed plus its strongest companions (co-occurring first, then
// same-artist fill) — exactly the walk the model would do.
const companions = [...ctx.co_occurring_tracks, ...ctx.same_artist].slice(0, 4);
const trackIds = [seed.persistent_id, ...companions.map((t) => t.persistent_id)];

step(`preview_playlist: ${trackIds.length} tracks → "Selecta Preview"`);
const preview = await call(client, 'preview_playlist', { track_ids: trackIds });
console.log(JSON.stringify(preview));

step(`create_playlist: "${SMOKE_PLAYLIST}"`);
const created = await call(client, 'create_playlist', {
  name: SMOKE_PLAYLIST,
  track_ids: trackIds,
  description: 'created by npm run smoke — safe to delete',
});
console.log(JSON.stringify(created));
if (created.track_count !== trackIds.length) {
  fail(`created ${created.track_count} tracks, expected ${trackIds.length}`);
}

step('verify via list_playlists, then clean up');
const playlists = await call(client, 'list_playlists', { name_query: SMOKE_PLAYLIST });
if (!playlists.playlists.some((p) => p.id === created.playlist_id)) {
  fail('created playlist not visible in cache');
}
const { deletePlaylistsByName } = await import(join(root, 'dist/bridge/index.js'));
await deletePlaylistsByName(SMOKE_PLAYLIST);
console.log('smoke playlist deleted from Music.app (by name — fresh playlist IDs are transient)');

console.log(
  '\nSMOKE PASSED — check Music.app: "Selecta Preview" should hold the audition tracklist.',
);
await client.close();
process.exit(0);
