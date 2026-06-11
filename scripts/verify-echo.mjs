#!/usr/bin/env node
// iCloud-echo reconciliation verification (docs/design.md §Implementation
// notes): create a throwaway playlist, poll Music.app every 15s for 5 minutes
// to watch for a sync echo twin, then run refresh_library and assert exactly
// one copy survives. The echo is non-deterministic — a run with no echo still
// PASSES but says so. Cleans up the probe playlist at the end.
// Run with `npm run verify:echo` (slow, talks to the real Music.app).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROBE = `Selecta Echo Probe ${Date.now()}`;
const POLL_INTERVAL_MS = 15_000;
const POLL_DURATION_MS = 5 * 60_000;
const root = dirname(dirname(fileURLToPath(import.meta.url)));

const step = (name) => process.stdout.write(`\n=== ${name}\n`);
const now = () => new Date().toISOString();
const fail = (msg) => {
  console.error(`VERIFY FAILED: ${msg}`);
  process.exit(1);
};

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const body = JSON.parse(result.content[0].text);
  if (result.isError) fail(`${name} → ${body.error}: ${body.hint}`);
  return body;
}

const { listPlaylistsByName, deletePlaylistsByName } = await import(
  join(root, 'dist/bridge/index.js')
);

const client = new Client({ name: 'selecta-verify-echo', version: '0.1.0' });
await client.connect(
  new StdioClientTransport({ command: 'node', args: [join(root, 'dist/index.js')] }),
);

step('pick probe tracks from the cache');
let search = await call(client, 'search', { limit: 5 });
if (search.tracks.length === 0) {
  step('cache empty — refresh_library first');
  await call(client, 'refresh_library', {});
  search = await call(client, 'search', { limit: 5 });
  if (search.tracks.length === 0) fail('library has no tracks');
}
const trackIds = search.tracks.map((t) => t.persistent_id);

step(`create_playlist: "${PROBE}" (${trackIds.length} tracks)`);
const created = await call(client, 'create_playlist', {
  name: PROBE,
  track_ids: trackIds,
  description: 'created by npm run verify:echo — safe to delete',
});
console.log(`${now()} created id=${created.playlist_id}`);

step(`poll Music.app every ${POLL_INTERVAL_MS / 1000}s for ${POLL_DURATION_MS / 60_000}min`);
let echoSeen = false;
const deadline = Date.now() + POLL_DURATION_MS;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  let copies;
  try {
    copies = await listPlaylistsByName(PROBE);
  } catch (err) {
    fail(`listPlaylistsByName failed during poll: ${err.message}`);
  }
  const desc = copies.map((c) => `${c.persistentId}#${c.trackCount}`).join(', ') || 'none';
  console.log(`${now()} copies=${copies.length} [${desc}]`);
  if (copies.length > 1) echoSeen = true;
}

step('refresh_library (reconciles any echo)');
const refresh = await call(client, 'refresh_library', {});
console.log(JSON.stringify(refresh.sync_reconciliation ?? { note: 'no reconciliation needed' }));

step('assert exactly one copy survives');
const survivors = await listPlaylistsByName(PROBE);
console.log(`${now()} copies=${survivors.length} [${survivors.map((c) => c.persistentId).join(', ')}]`);
if (survivors.length !== 1) {
  fail(`expected exactly 1 copy of "${PROBE}", found ${survivors.length}`);
}

step('clean up probe playlist');
try {
  await deletePlaylistsByName(PROBE);
} catch (err) {
  // The verdict is already decided — a teardown hiccup must not obscure it.
  console.error(`Warning: cleanup failed (${err.message}); probe "${PROBE}" may remain in Music.app`);
}
console.log(
  echoSeen
    ? '\nVERIFY PASSED — echo observed and reconciled to a single copy.'
    : '\nVERIFY PASSED — no echo occurred this run (non-deterministic); single copy confirmed.',
);
await client.close();
process.exit(0);
