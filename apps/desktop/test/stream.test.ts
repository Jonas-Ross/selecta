import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseStreamLine } from '../src/host/stream.js';

// A real `claude -p` build against the fixture library, trimmed to the lines
// the parser reads plus the noise it has to skip.
const recorded = readFileSync(new URL('./fixtures/build-draft.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n');

it('reduces a recorded build to narration, tool calls and one terminal event', () => {
  const events = recorded.flatMap(parseStreamLine);

  expect(
    events
      .filter((event) => event.kind === 'tool')
      .map((event) => event.kind === 'tool' && event.name),
  ).toEqual(['search', 'search', 'library_overview', 'search', 'show_playlist_draft']);
  expect(events.filter((event) => event.kind === 'text')).toHaveLength(5);
  expect(events.at(-1)).toEqual({
    kind: 'done',
    session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  });
  expect(events.filter((event) => event.kind === 'done' || event.kind === 'error')).toHaveLength(1);
});

it('ignores lines it cannot read', () => {
  expect(parseStreamLine('not json')).toEqual([]);
  expect(parseStreamLine('{"type":"future_thing"}')).toEqual([]);
});

it('reports denials before an error result', () => {
  expect(
    parseStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        permission_denials: [{ tool_name: 'mcp__selecta__save_playlist_draft' }],
      }),
    ),
  ).toEqual([
    { kind: 'denied', name: 'save_playlist_draft' },
    { kind: 'error', message: 'error_max_turns' },
  ]);
});
