// The app's core process. It runs under the system Node rather than inside
// Electron, so better-sqlite3 keeps the one native build that the MCP server and
// tests already use. It speaks JSON lines on stdio with Electron main.
import { createInterface } from 'node:readline';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SelectaCache, defaultDbPath } from '@selecta/core/cache/index.js';
import { bridge } from '@selecta/core/bridge/index.js';
import { DraftStore, draftDbPath } from '@selecta/core/drafts/store.js';
import { artworkDir } from '../shared/artwork.js';
import type { HostEvent } from '../shared/protocol.js';
import { createActionLog } from './actions.js';
import { AgentSessions } from './agent.js';
import { createApi } from './api.js';
import { createArtworkCache, sipsThumbnail } from './artwork.js';
import { watchDrafts } from './watch.js';

const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
const emit = (event: HostEvent) => send(event);

const actions = createActionLog();
const dbPath = defaultDbPath();
let cache: SelectaCache | undefined;
const agent = new AgentSessions({
  // The root build keeps <repo>/dist/index.js pointing at the MCP server.
  mcpEntry: fileURLToPath(new URL('../../../dist/index.js', import.meta.url)),
  claudePath: process.env.SELECTA_CLAUDE_PATH,
  // Outside any project, so no CLAUDE.md or project settings leak into the run.
  cwd: tmpdir(),
  emit: (draft_id, data, seq) => {
    actions.note('agent', { draft_id, ...data });
    emit({ event: 'agent', draft_id, seq, data });
  },
});
const call = createApi(
  {
    cache: () => (cache ??= SelectaCache.open(dbPath)),
    bridge,
    drafts: () => new DraftStore(draftDbPath(dbPath)),
  },
  agent,
  createArtworkCache({
    dir: artworkDir(homedir()),
    read: (trackIds, dir) => bridge.readArtwork(trackIds, dir),
    resize: sipsThumbnail,
    log: (message) => console.error(message),
  }),
);
const stopWatching = watchDrafts(
  draftDbPath(dbPath),
  () => emit({ event: 'drafts.changed' }),
  (error) => console.error(`selecta: cannot watch drafts.db for changes: ${error.message}`),
);

async function answer(line: string) {
  const { id, method, args } = JSON.parse(line) as { id: number; method: string; args?: unknown };

  try {
    send({ id, result: (await actions.record(method, args, () => call(method, args))) ?? null });
  } catch (error) {
    send({ id, error: error instanceof Error ? error.message : String(error) });
  }
}

createInterface({ input: process.stdin })
  .on('line', (line) => void answer(line))
  // Main closing stdin is the shutdown signal.
  .on('close', () => {
    agent.cancelAll();
    stopWatching();
    cache?.close();
  });
