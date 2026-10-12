import { expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from 'selecta/dist/server.js';
import { SelectaCache } from '@selecta/core/cache/index.js';
import { makeBridge } from '../../../packages/core/test/helpers.js';
import { ALLOWED_TOOLS, DENIED_TOOLS } from '../src/host/providers.js';
import { SUGGEST_TOOLS } from '../src/host/suggest.js';

// A tool added to the MCP server must be sorted into one list or the other,
// so the app's agent never picks up a new write by default.
it('sorts every MCP tool into allowed or denied for the in-app agent', async () => {
  const server = createServer({ cache: () => SelectaCache.open(':memory:'), bridge: makeBridge() });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();

  expect(tools.map((tool) => tool.name).sort()).toEqual([...ALLOWED_TOOLS, ...DENIED_TOOLS].sort());
  await client.close();
});

it('gives a suggestion run only tools that read', () => {
  expect(SUGGEST_TOOLS.every((name) => ALLOWED_TOOLS.includes(name))).toBe(true);
  expect(SUGGEST_TOOLS).toContain('get_playlist_draft');
  expect(SUGGEST_TOOLS).not.toContain('show_playlist_draft');
  expect(SUGGEST_TOOLS).not.toContain('edit_playlist_draft');
});
