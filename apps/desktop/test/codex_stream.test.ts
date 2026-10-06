import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseCodexLine } from '../src/host/codex_stream.js';

// Real `codex exec --json` 0.160.1 output, driven by a stand-in model against a
// stand-in selecta server; the line shapes are Codex's own.
const recorded = readFileSync(new URL('./fixtures/codex-build.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n');

it('reduces a recorded run to narration, tool calls and a done carrying the thread', () => {
  expect(recorded.flatMap(parseCodexLine())).toEqual([
    { kind: 'tool', name: 'search' },
    { kind: 'text', text: 'All done.' },
    { kind: 'done', session_id: '01a1130a-c0d9-78c3-bb2c-e04774b2e218' },
  ]);
});

it('ends on turn.failed and skips the retry notices before it', () => {
  const parse = parseCodexLine();
  const lines = [
    { type: 'error', message: 'Reconnecting... 1/5 (unexpected status 401 Unauthorized)' },
    { type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } },
  ];

  expect(lines.flatMap((line) => parse(JSON.stringify(line)))).toEqual([
    { kind: 'error', message: 'unexpected status 401 Unauthorized' },
  ]);
  expect(parse('not json')).toEqual([]);
});
