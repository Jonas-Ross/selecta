// MCP wire-level smoke: a real client over the SDK's in-memory transport pair.
// Verifies tool registration, JSON round-trip, and isError on envelopes —
// without Music.app or a child process.

import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { SelectaCache } from '../src/cache/index.js';
import type { LibrarySnapshot } from '../src/types/bridge.js';
import { makeBridge } from './helpers.js';
import fixture from './fixtures/library.json' with { type: 'json' };

const snapshot = fixture as LibrarySnapshot;

const unusedBridge = makeBridge();

async function connectedClient(): Promise<Client> {
  const cache = SelectaCache.open(':memory:');
  cache.refreshFromSnapshot(snapshot, { durationMs: 1 });
  const server = createServer({ cache: () => cache, bridge: unusedBridge });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text: string }[];
  expect(content[0]!.type).toBe('text');
  return content[0]!.text;
}

describe('MCP server over in-memory transport', () => {
  it('exposes the fifteen tools', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_tracks',
      'create_playlist',
      'delete_playlist',
      'enrich_features',
      'get_track_context',
      'inspect_tracklist',
      'library_overview',
      'list_playlists',
      'preview_playlist',
      'refresh_library',
      'remove_tracks',
      'reorder_tracks',
      'search',
      'set_loved',
      'set_rating',
    ]);
    // Tool descriptions are first-class — they must survive the wire.
    const search = tools.find((t) => t.name === 'search')!;
    const context = tools.find((t) => t.name === 'get_track_context')!;
    expect(search.description).toContain('refresh_library');
    expect(search.description).toContain('compact true');
    expect(context.description).toContain('compact true');
    expect(search.inputSchema).toMatchObject({ properties: { compact: { type: 'boolean' } } });
    expect(context.inputSchema).toMatchObject({ properties: { compact: { type: 'boolean' } } });
  });

  it('round-trips a search call as JSON text content', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'search',
      arguments: { query: 'teardrop' },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(textOf(result));
    expect(body.tracks[0].persistent_id).toBe('T-TEARDROP');
    expect(body.cache_age_hours).not.toBeNull();
  });

  it('round-trips the self-describing compact search rows', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'search',
      arguments: { query: 'teardrop', compact: true },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(textOf(result));
    expect(body.track_fields[0]).toBe('persistent_id');
    expect(body.track_fields).toContain('genre');
    expect(body.track_fields).toContain('signal.date_added');
    expect(body.tracks[0].track[0]).toBe('T-TEARDROP');
  });

  it('marks structured error envelopes with isError', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'get_track_context',
      arguments: { track_id: 'T-NOPE' },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.error).toBe('track_not_found');
    expect(body.hint).toBeTruthy();
  });
});
