// The subset of Markdown agents write in a chat reply, parsed to plain data so
// nothing an agent says ever reaches the page as HTML.

export type Inline =
  | string
  | { kind: 'code'; text: string }
  | { kind: 'strong' | 'em' | 'del'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] };

export type Block =
  | { kind: 'p'; lines: Inline[][] }
  | { kind: 'heading'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'rule' };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
const NUMBER = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;

function starts(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    NUMBER.test(line) ||
    RULE.test(line)
  );
}

const indent = (line: string) => line.length - line.trimStart().length;

/** Whether a blank line at `i` sits inside a list rather than ending it. */
function continues(lines: string[], i: number, base: number, marker: RegExp): boolean {
  const next = lines.slice(i).find((line) => line.trim());

  return next !== undefined && (indent(next) >= base + 2 || marker.test(next));
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);

    if (!line.trim()) {
      i++;
    } else if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      const body: string[] = [];

      // An unclosed fence runs to the end, as a streamed reply's last block may.
      for (i++; i < lines.length && !close.test(lines[i]!); i++) body.push(lines[i]!);

      i++;
      blocks.push({ kind: 'code', text: body.join('\n') });
    } else if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
    } else if (HEADING.test(line)) {
      blocks.push({ kind: 'heading', children: parseInline(HEADING.exec(line)![1]!) });
      i++;
    } else if (QUOTE.test(line)) {
      const body: string[] = [];

      for (; i < lines.length && QUOTE.test(lines[i]!); i++)
        body.push(lines[i]!.replace(QUOTE, ''));

      blocks.push({ kind: 'quote', blocks: parseMarkdown(body.join('\n')) });
    } else {
      const ordered = NUMBER.exec(line);

      if (ordered || BULLET.test(line)) {
        const marker = ordered ? NUMBER : BULLET;
        const base = indent(line);
        const items: string[][] = [];
        let width = 0;

        while (i < lines.length) {
          const next = lines[i]!;
          const item = marker.exec(next);

          if (item && indent(next) < base + 2) {
            width = item[0].length - item.at(-1)!.length;
            items.push([item.at(-1)!]);
          } else if (next.trim() && indent(next) >= base + 2) {
            // Indented under an item: its continuation, or a nested block.
            items.at(-1)!.push(next.slice(Math.min(indent(next), width)));
          } else if (!next.trim() && continues(lines, i, base, marker)) {
            items.at(-1)!.push('');
          } else break;

          i++;
        }

        blocks.push({
          kind: 'list',
          ordered: !!ordered,
          start: ordered ? Number(ordered[1]) : 1,
          items: items.map((body) => parseMarkdown(body.join('\n'))),
        });
      } else {
        const body: string[] = [];

        for (; i < lines.length && lines[i]!.trim() && !(body.length && starts(lines[i]!)); i++)
          body.push(lines[i]!.trim());

        blocks.push({ kind: 'p', lines: body.map(parseInline) });
      }
    }
  }

  return blocks;
}

const PUNCT = /[!-/:-@[-`{-~]/;
const SAFE_LINK = /^(https?:|mailto:)/i;
// One level of balanced parentheses in the URL, as Wikipedia's have.
const LINK = /^\[([^\]]+)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))+)>?\s*\)/;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = '';
  let i = 0;

  const flush = () => {
    if (plain) out.push(plain);

    plain = '';
  };
  const push = (node: Inline, next: number) => {
    flush();
    out.push(node);
    i = next;
  };

  while (i < text.length) {
    const c = text[i]!;

    if (c === '\\' && PUNCT.test(text[i + 1] ?? '')) {
      plain += text[i + 1];
      i += 2;
      continue;
    }

    if (c === '`') {
      const run = /^`+/.exec(text.slice(i))![0];
      const end = text.indexOf(run, i + run.length);

      if (end > 0) {
        push(
          { kind: 'code', text: text.slice(i + run.length, end).trim() || ' ' },
          end + run.length,
        );
        continue;
      }

      plain += run;
      i += run.length;
      continue;
    }

    if (c === '[') {
      const link = LINK.exec(text.slice(i));

      if (link) {
        const label = parseInline(link[1]!);

        flush();

        // Anything but a web or mail link keeps only its label.
        if (SAFE_LINK.test(link[2]!)) out.push({ kind: 'link', href: link[2]!, children: label });
        else out.push(...label);

        i += link[0].length;
        continue;
      }
    }

    const span = emphasis(text, i);

    if (span) {
      push(span.node, span.end);
      continue;
    }

    plain += c;
    i++;
  }

  flush();

  return out;
}

const WORD = /[\p{L}\p{N}]/u;

/** Where `delim` occurs from `from` on, outside code spans, escapes and links. */
function* closers(text: string, delim: string, from: number): Generator<number> {
  for (let j = from; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '`') {
      const run = /^`+/.exec(text.slice(j))![0];
      const end = text.indexOf(run, j + run.length);

      j = (end > 0 ? end : j) + run.length - 1;
    } else if (text.startsWith(delim, j)) yield j;
    else if (text[j] === '[') {
      // A link's URL may hold the delimiter, which never closes a span.
      const link = LINK.exec(text.slice(j));

      if (link) j += link[0].length - 1;
    }
  }
}

/** A delimiter run at `i` with a matching closer, in CommonMark's spirit if not its letter. */
function emphasis(text: string, i: number): { node: Inline; end: number } | undefined {
  for (const [delim, kind] of [
    ['***', 'strong'],
    ['___', 'strong'],
    ['**', 'strong'],
    ['__', 'strong'],
    ['~~', 'del'],
    ['*', 'em'],
    ['_', 'em'],
  ] as const) {
    if (!text.startsWith(delim, i)) continue;

    const open = i + delim.length;
    const before = text[i - 1] ?? ' ';

    // An opener must touch its text, and `_` never opens inside a word (snake_case).
    if (
      !text[open] ||
      /\s/.test(text[open]) ||
      (delim[0] === '_' && WORD.test(before)) ||
      (delim.length === 1 && text[open] === delim)
    )
      continue;

    for (const end of closers(text, delim, open + 1)) {
      const after = text[end + delim.length] ?? ' ';

      // A closer touches its text, and a lone `*` is never half of a `**`.
      if (
        /\s/.test(text[end - 1]!) ||
        (delim[0] === '_' && WORD.test(after)) ||
        (delim.length === 1 && (after === delim || text[end - 1] === delim))
      )
        continue;

      const children = parseInline(text.slice(open, end));

      return {
        // A triple run is bold italics.
        node: { kind, children: delim.length === 3 ? [{ kind: 'em', children }] : children },
        end: end + delim.length,
      };
    }
  }

  return undefined;
}
