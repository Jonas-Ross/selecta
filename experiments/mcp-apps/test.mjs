import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
test('fixture stdio contract, UI resource, errors and draft identity', async () => {
  const client = new Client({ name: 'fixture-protocol-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('./server.mjs', import.meta.url).pathname],
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();

    assert.equal(tools.length, 2);
    const picker = tools.find((t) => t.name === 'show_fixture_tracks');

    assert.equal(picker._meta.ui.resourceUri, 'ui://selecta-poc/tracks.html');
    assert.ok(tools.every((t) => t.annotations.readOnlyHint && !t.annotations.destructiveHint));
    const resource = await client.readResource({ uri: picker._meta.ui.resourceUri });

    assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.match(resource.contents[0].text, /Send selection to agent/);
    const first = await client.callTool({ name: picker.name, arguments: { draft: 'A' } });
    const second = await client.callTool({ name: picker.name, arguments: { draft: 'B' } });

    assert.equal(first.structuredContent.draft, 'A');
    assert.equal(second.structuredContent.draft, 'B');
    assert.equal(first.structuredContent.tracks.length, 3);
    assert.match(first.content[0].text, /fixture-1: Paper Moon/);
    const echo = await client.callTool({
      name: 'echo_fixture_selection',
      arguments: { draft: 'A', ids: ['fixture-2'] },
    });

    assert.deepEqual(JSON.parse(echo.content[0].text), { draft: 'A', ids: ['fixture-2'] });
    const failure = await client.callTool({
      name: 'echo_fixture_selection',
      arguments: { draft: 'A', ids: [], controlled_error: true },
    });

    assert.equal(failure.isError, true);
    assert.match(failure.content[0].text, /CONTROLLED_ERROR/);
    const invalid = await client.callTool({
      name: 'echo_fixture_selection',
      arguments: { draft: 'A', ids: ['real-track'] },
    });

    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
  }
});
