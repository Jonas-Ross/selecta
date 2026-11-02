import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseStream } from '../src/host/stream.js';

// A real `claude -p` build against the fixture library, trimmed to the lines
// the parser reads plus the noise it has to skip.
const recorded = readFileSync(new URL('./fixtures/build-draft.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n');

it('reduces a recorded build to narration, tool calls and one terminal event', () => {
  const events = recorded.flatMap(parseStream());

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
  const parse = parseStream();

  expect(parse('not json')).toEqual([]);
  expect(parse('{"type":"future_thing"}')).toEqual([]);
});

it('reports denials before an error result', () => {
  expect(
    parseStream()(
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

it('says a failed request once, flagging a lapsed login', () => {
  const expired = 'Failed to authenticate: OAuth session expired and could not be refreshed';
  const failure = (error: string) => [
    JSON.stringify({
      type: 'assistant',
      error,
      message: { model: '<synthetic>', content: [{ type: 'text', text: expired }] },
    }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: expired }),
  ];

  expect(failure('authentication_failed').flatMap(parseStream())).toEqual([
    { kind: 'error', message: expired, signedOut: true },
  ]);
  expect(failure('server_error').flatMap(parseStream())).toEqual([
    { kind: 'error', message: expired },
  ]);
});

it('keeps a failure reply as the reason when the result gives none, and forgets it once the run goes on', () => {
  const parse = parseStream();
  const line = (data: object) => parse(JSON.stringify(data));

  line({
    type: 'assistant',
    error: 'authentication_failed',
    message: { content: [{ text: 'x' }] },
  });
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Back.' }] } });
  expect(line({ type: 'result', subtype: 'error_max_turns', is_error: true })).toEqual([
    { kind: 'error', message: 'error_max_turns' },
  ]);

  const quiet = parseStream();

  quiet(
    JSON.stringify({
      type: 'assistant',
      error: 'billing_error',
      message: { content: [{ type: 'text', text: 'Credit balance is too low' }] },
    }),
  );
  expect(quiet(JSON.stringify({ type: 'result', subtype: 'error_during_execution' }))).toEqual([
    { kind: 'error', message: 'Credit balance is too low' },
  ]);
});
