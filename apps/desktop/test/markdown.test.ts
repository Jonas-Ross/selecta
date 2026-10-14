import { expect, it } from 'vitest';
import { parseInline, parseMarkdown } from '../src/renderer/markdown.js';

it('reads bold, italic, code and strikethrough', () => {
  expect(parseInline('a **b** _c_ *d* `e*f*` ~~g~~')).toEqual([
    'a ',
    { kind: 'strong', children: ['b'] },
    ' ',
    { kind: 'em', children: ['c'] },
    ' ',
    { kind: 'em', children: ['d'] },
    ' ',
    { kind: 'code', text: 'e*f*' },
    ' ',
    { kind: 'del', children: ['g'] },
  ]);
});

it('nests emphasis inside bold', () => {
  expect(parseInline('**a *b* c**')).toEqual([
    { kind: 'strong', children: ['a ', { kind: 'em', children: ['b'] }, ' c'] },
  ]);
});

it('reads a triple run as bold italics', () => {
  const both = [{ kind: 'strong', children: [{ kind: 'em', children: ['important'] }] }];

  expect(parseInline('***important***')).toEqual(both);
  expect(parseInline('___important___')).toEqual(both);
});

it('splits a triple run whose spans close apart', () => {
  expect(parseInline('***bold** rest*')).toEqual([
    { kind: 'em', children: [{ kind: 'strong', children: ['bold'] }, ' rest'] },
  ]);
  expect(parseInline('***it* rest**')).toEqual([
    { kind: 'strong', children: [{ kind: 'em', children: ['it'] }, ' rest'] },
  ]);
});

it('never closes emphasis inside code, a link or on an escaped marker', () => {
  expect(parseInline('*run `a*b` now*')).toEqual([
    { kind: 'em', children: ['run ', { kind: 'code', text: 'a*b' }, ' now'] },
  ]);
  expect(parseInline('*see [it](https://a.com/a*b) now*')).toEqual([
    {
      kind: 'em',
      children: ['see ', { kind: 'link', href: 'https://a.com/a*b', children: ['it'] }, ' now'],
    },
  ]);
  expect(parseInline('**a \\** b**')).toEqual([{ kind: 'strong', children: ['a ** b'] }]);
});

it('leaves stray markers and snake_case alone', () => {
  expect(parseInline('2 * 3 * 4')).toEqual(['2 * 3 * 4']);
  expect(parseInline('track_id and draft_id')).toEqual(['track_id and draft_id']);
  expect(parseInline('**unclosed')).toEqual(['**unclosed']);
  expect(parseInline('\\*literal\\*')).toEqual(['*literal*']);
});

it('links only to the web or mail, keeping the label of anything else', () => {
  expect(parseInline('[site](https://example.com)')).toEqual([
    { kind: 'link', href: 'https://example.com', children: ['site'] },
  ]);
  expect(parseInline('[x](javascript:alert(1))')).toEqual(['x']);
  expect(parseInline('[f](file:///etc/passwd)')).toEqual(['f']);
});

it('passes raw HTML through as text', () => {
  expect(parseMarkdown('<img src=x onerror=alert(1)>')).toEqual([
    { kind: 'p', lines: [['<img src=x onerror=alert(1)>']] },
  ]);
});

it('keeps a numbered list continuing from an earlier one at its own number', () => {
  const blocks = parseMarkdown(
    'Here are some more:\n\n5. **Bass in the Red**\n6. **Full Send**, a nod\n\nThe name is still **Redline**.',
  );

  expect(blocks).toEqual([
    { kind: 'p', lines: [['Here are some more:']] },
    {
      kind: 'list',
      ordered: true,
      start: 5,
      items: [
        [{ kind: 'p', lines: [[{ kind: 'strong', children: ['Bass in the Red'] }]] }],
        [{ kind: 'p', lines: [[{ kind: 'strong', children: ['Full Send'] }, ', a nod']] }],
      ],
    },
    { kind: 'p', lines: [['The name is still ', { kind: 'strong', children: ['Redline'] }, '.']] },
  ]);
});

const para = (text: string) => ({ kind: 'p', lines: [[text]] });

it('holds a loose list together and keeps indented lines in their item', () => {
  expect(parseMarkdown('- one\n  more\n\n- two\n\nafter')).toEqual([
    {
      kind: 'list',
      ordered: false,
      start: 1,
      items: [[{ kind: 'p', lines: [['one'], ['more']] }], [para('two')]],
    },
    para('after'),
  ]);
});

it('nests a list under an item', () => {
  expect(parseMarkdown('1. Openers\n   - Pressure Drop\n   - Afterburner\n2. Closers')).toEqual([
    {
      kind: 'list',
      ordered: true,
      start: 1,
      items: [
        [
          para('Openers'),
          {
            kind: 'list',
            ordered: false,
            start: 1,
            items: [[para('Pressure Drop')], [para('Afterburner')]],
          },
        ],
        [para('Closers')],
      ],
    },
  ]);
});

it('reads fences, headings, quotes and rules, keeping line breaks in a paragraph', () => {
  expect(parseMarkdown('## Plan\nfirst\nsecond\n```\nlet *x* = 1\n```\n> quoted\n\n---')).toEqual([
    { kind: 'heading', children: ['Plan'] },
    { kind: 'p', lines: [['first'], ['second']] },
    { kind: 'code', text: 'let *x* = 1' },
    { kind: 'quote', blocks: [{ kind: 'p', lines: [['quoted']] }] },
    { kind: 'rule' },
  ]);
});

it('runs an unclosed fence to the end', () => {
  expect(parseMarkdown('```ts\nconst a = 1')).toEqual([{ kind: 'code', text: 'const a = 1' }]);
});
