import { expect, it } from 'vitest';
import { parsePicks, suggestPrompt } from '../src/host/suggest.js';

it('names the record, its place, the brief, what to leave out and what the user asked', () => {
  const prompt = suggestPrompt({
    draftId: 'D-1',
    position: 3,
    count: 8,
    trackId: 'T-1',
    title: 'Roads',
    artist: 'Portishead',
    brief: 'Late night',
    ask: 'more vocal',
    exclude: ['T-2', 'T-3'],
  });

  expect(prompt).toMatch(/^Draft ID: D-1\n/);
  expect(prompt).toContain('record 3 of 8: "Roads" by Portishead (track ID T-1)');
  expect(prompt).toContain("The draft's brief:\nLate night");
  expect(prompt).toContain('leave these out: T-2, T-3');
  expect(prompt).toContain('The user asks for:\nmore vocal');
  expect(suggestPrompt({ draftId: 'D', position: 1, count: 1, trackId: 'T' })).not.toMatch(
    /brief|leave these out|asks for/,
  );
});

it('reads the last picks object out of the reply, around prose and fences', () => {
  const picks = [{ track_id: 'T-1', reason: 'Close in tempo.' }];

  expect(parsePicks(`Here you go.\n${JSON.stringify({ picks })}`)).toEqual(picks);
  expect(parsePicks(`\`\`\`json\n${JSON.stringify({ picks })}\n\`\`\`\nEnjoy {them}.`)).toEqual(
    picks,
  );
  expect(
    parsePicks(
      `{"picks":[{"track_id":"OLD","reason":""}]} then {"picks":${JSON.stringify(picks)}}`,
    ),
  ).toEqual(picks);
});

it('reads nothing from a reply without valid picks, and blanks a bad reason', () => {
  expect(parsePicks('Nothing fits.')).toEqual([]);
  expect(parsePicks('{"picks": [{"track_id": ""}]}')).toEqual([]);
  expect(parsePicks('{"picks": [ {"track_id": "T-1", "reason": "cut off')).toEqual([]);
  expect(parsePicks('{"picks":[{"track_id":"T-1","reason":7}]}')).toEqual([
    { track_id: 'T-1', reason: '' },
  ]);
});
