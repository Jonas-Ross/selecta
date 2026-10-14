// An agent's reply as plain data: micromark parses CommonMark (plus GFM
// strikethrough and bare links) to a syntax tree, and only the parts the panel
// draws are kept, so nothing an agent says ever reaches the page as HTML.
import type { Nodes, PhrasingContent, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';

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

const SAFE_LINK = /^(https?:|mailto:)/i;

const options = {
  extensions: [gfmStrikethrough(), gfmAutolinkLiteral()],
  mdastExtensions: [gfmStrikethroughFromMarkdown(), gfmAutolinkLiteralFromMarkdown()],
};

export function parseMarkdown(source: string): Block[] {
  return blocks(fromMarkdown(source, options).children);
}

/** A line of inline Markdown, without its paragraph. */
export function parseInline(text: string): Inline[] {
  return parseMarkdown(text).flatMap((block) => (block.kind === 'p' ? block.lines.flat() : []));
}

function blocks(nodes: RootContent[]): Block[] {
  return nodes.flatMap((node): Block[] => {
    switch (node.type) {
      case 'paragraph':
        return [{ kind: 'p', lines: lines(node.children) }];
      case 'heading':
        return [{ kind: 'heading', children: inline(node.children) }];
      case 'code':
        return [{ kind: 'code', text: node.value }];
      case 'blockquote':
        return [{ kind: 'quote', blocks: blocks(node.children) }];
      case 'list':
        return [
          {
            kind: 'list',
            ordered: !!node.ordered,
            start: node.start ?? 1,
            items: node.children.map((item) => blocks(item.children)),
          },
        ];
      case 'thematicBreak':
        return [{ kind: 'rule' }];
      // Raw HTML stays visible as the text it is.
      case 'html':
        return [{ kind: 'p', lines: [[node.value]] }];
      default:
        return [];
    }
  });
}

/** A paragraph's content, split where the reply broke its lines. */
function lines(nodes: PhrasingContent[]): Inline[][] {
  const out: Inline[][] = [[]];

  for (const node of inline(nodes)) {
    if (typeof node !== 'string') {
      out.at(-1)!.push(node);
      continue;
    }

    node.split('\n').forEach((part, n) => {
      if (n > 0) out.push([]);

      if (part) out.at(-1)!.push(part);
    });
  }

  return out;
}

function inline(nodes: PhrasingContent[]): Inline[] {
  const out: Inline[] = [];

  for (const item of nodes.flatMap(phrase)) {
    // Escapes and entities arrive as separate text nodes.
    if (typeof item === 'string' && typeof out.at(-1) === 'string') out[out.length - 1] += item;
    else out.push(item);
  }

  return out;
}

function phrase(node: PhrasingContent): Inline[] {
  switch (node.type) {
    case 'text':
    case 'html':
      return [node.value];
    case 'break':
      return ['\n'];
    case 'inlineCode':
      return [{ kind: 'code', text: node.value }];
    case 'strong':
      return [{ kind: 'strong', children: inline(node.children) }];
    case 'emphasis':
      return [{ kind: 'em', children: inline(node.children) }];
    case 'delete':
      return [{ kind: 'del', children: inline(node.children) }];
    case 'link':
      // Anything but a web or mail link keeps only its label.
      return SAFE_LINK.test(node.url)
        ? [{ kind: 'link', href: node.url, children: inline(node.children) }]
        : inline(node.children);
    case 'image':
    case 'imageReference':
      return node.alt ? [node.alt] : [];
    case 'linkReference':
      return inline(node.children);
    default:
      return text(node);
  }
}

/** Whatever else turns up, as its plain text. */
function text(node: Nodes): string[] {
  if ('value' in node) return [node.value];

  if ('children' in node) return node.children.flatMap((child) => text(child as Nodes));

  return [];
}
