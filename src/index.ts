#!/usr/bin/env node
// Selecta CLI entrypoint. Minimal stop-gap dispatch for the M1 spike — replaced
// by a commander-based surface in M2 (default action starts the MCP server;
// verbs like `refresh` hang off subcommands). See CLAUDE.md.
//
// M1 ships one temporary debug verb, `bridge:read-playlist`, removed in M2 once
// `selecta refresh` exists. stdout carries only the JSON payload; everything
// else goes to stderr via the log shim.

import { bridge } from './bridge/index.js';
import { BridgeError, defaultHints } from './errors.js';
import { log } from './log.js';

const USAGE = `selecta — Apple Music library bridge for Claude

Usage:
  selecta bridge:read-playlist <persistent_id>   Read one playlist as JSON (debug; removed in M2)
`;

async function readPlaylistVerb(persistentId: string | undefined): Promise<number> {
  if (!persistentId) {
    log.error('bridge:read-playlist requires a <persistent_id> argument.');
    return 1;
  }
  try {
    const playlist = await bridge.readPlaylist(persistentId);
    process.stdout.write(JSON.stringify(playlist) + '\n');
    return 0;
  } catch (err) {
    if (err instanceof BridgeError) {
      log.error(`[${err.errorCode}] ${err.message}`);
      log.error(`hint: ${err.hint ?? defaultHints[err.errorCode]}`);
    } else {
      log.error('Unexpected error:', err instanceof Error ? err.message : String(err));
    }
    return 1;
  }
}

async function main(): Promise<number> {
  const [verb, ...rest] = process.argv.slice(2);
  switch (verb) {
    case 'bridge:read-playlist':
      return readPlaylistVerb(rest[0]);
    case '-h':
    case '--help':
      process.stderr.write(USAGE);
      return 0;
    case undefined:
      process.stderr.write(USAGE);
      return 1;
    default:
      log.error(`Unknown verb: ${verb}`);
      process.stderr.write(USAGE);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log.error('Fatal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
