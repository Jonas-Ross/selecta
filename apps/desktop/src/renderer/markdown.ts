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
  | { kind: 'br' }
  | { kind: 'code'; text: string }
  | { kind: 'strong' | 'em' | 'del'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] };

export type Block =
  | { kind: 'p'; children: Inline[] }
  | { kind: 'heading'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'rule' };

const BR: Inline = { kind: 'br' };
const SAFE_LINK = /^(https?:|mailto:)/i;

const options = {
  extensions: [gfmStrikethrough(), gfmAutolinkLiteral()],
  mdastExtensions: [gfmStrikethroughFromMarkdown(), gfmAutolinkLiteralFromMarkdown()],
};

export function parseMarkdown(source: string): Block[] {
  const tree = fromMarkdown(source, options);
  const urls: Urls = new Map();

  // Reference links (`[docs][x]`) resolve through definitions anywhere in the reply.
  visit(tree, (node) => {
    if (node.type === 'definition' && !urls.has(node.identifier))
      urls.set(node.identifier, node.url);
  });

  return blocks(tree.children, urls);
}

type Urls = Map<string, string>;

function visit(node: Nodes, see: (node: Nodes) => void) {
  see(node);

  if ('children' in node) for (const child of node.children) visit(child, see);
}

/** A line of inline Markdown, without its paragraph. */
export function parseInline(text: string): Inline[] {
  return parseMarkdown(text).flatMap((block) => (block.kind === 'p' ? block.children : []));
}

function blocks(nodes: RootContent[], urls: Urls): Block[] {
  return nodes.flatMap((node): Block[] => {
    switch (node.type) {
      case 'paragraph':
        return [{ kind: 'p', children: inline(node.children, urls) }];
      case 'heading':
        return [{ kind: 'heading', children: inline(node.children, urls) }];
      case 'code':
        return [{ kind: 'code', text: node.value }];
      case 'blockquote':
        return [{ kind: 'quote', blocks: blocks(node.children, urls) }];
      case 'list':
        return [
          {
            kind: 'list',
            ordered: !!node.ordered,
            start: node.start ?? 1,
            items: node.children.map((item) => blocks(item.children, urls)),
          },
        ];
      case 'thematicBreak':
        return [{ kind: 'rule' }];
      // Raw HTML stays visible as the text it is.
      case 'html':
        return [{ kind: 'p', children: [node.value] }];
      default:
        return [];
    }
  });
}

function inline(nodes: PhrasingContent[], urls: Urls): Inline[] {
  const out: Inline[] = [];

  for (const item of nodes.flatMap((node) => phrase(node, urls))) {
    // Escapes and entities arrive as separate text nodes.
    if (typeof item === 'string' && typeof out.at(-1) === 'string') out[out.length - 1] += item;
    else out.push(item);
  }

  // A line break in the reply stays one, at any depth.
  return out.flatMap((item) =>
    typeof item === 'string'
      ? item
          .split('\n')
          .flatMap((part, n): Inline[] => [...(n ? [BR] : []), ...(part ? [part] : [])])
      : [item],
  );
}

function phrase(node: PhrasingContent, urls: Urls): Inline[] {
  switch (node.type) {
    case 'text':
    case 'html':
      return [node.value];
    case 'break':
      return ['\n'];
    case 'inlineCode':
      return [{ kind: 'code', text: node.value }];
    case 'strong':
      return [{ kind: 'strong', children: inline(node.children, urls) }];
    case 'emphasis':
      return [{ kind: 'em', children: inline(node.children, urls) }];
    case 'delete':
      return [{ kind: 'del', children: inline(node.children, urls) }];
    case 'link':

    case 'linkReference': {
      const href = node.type === 'link' ? node.url : (urls.get(node.identifier) ?? '');

      // Anything but a web or mail link keeps only its label.
      return SAFE_LINK.test(href)
        ? [{ kind: 'link', href, children: inline(node.children, urls) }]
        : inline(node.children, urls);
    }

    case 'image':
    case 'imageReference':
      return node.alt ? [node.alt] : [];
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
