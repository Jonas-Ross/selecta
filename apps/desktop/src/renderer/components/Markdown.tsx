// An agent's reply, formatted. Built from parsed data, never set as HTML.
import { useMemo, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '../markdown.js';

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, k) => {
    if (typeof node === 'string') return node;

    switch (node.kind) {
      case 'br':
        return <br key={k} />;
      case 'code':
        return <code key={k}>{node.text}</code>;
      case 'strong':
        return <strong key={k}>{inline(node.children)}</strong>;
      case 'em':
        return <em key={k}>{inline(node.children)}</em>;
      case 'del':
        return <del key={k}>{inline(node.children)}</del>;
      case 'link':
        // The main process opens it in the browser rather than in the app's window.
        return (
          <a key={k} href={node.href} target="_blank" rel="noreferrer" title={node.href}>
            {inline(node.children)}
          </a>
        );
    }
  });
}

function block(node: Block, k: number): ReactNode {
  switch (node.kind) {
    case 'p':
      return <p key={k}>{inline(node.children)}</p>;
    case 'heading':
      return (
        <p key={k} className="md-h">
          {inline(node.children)}
        </p>
      );
    case 'code':
      return (
        <pre key={k}>
          <code>{node.text}</code>
        </pre>
      );
    case 'quote':
      return <blockquote key={k}>{node.blocks.map(block)}</blockquote>;

    case 'list': {
      const items = node.items.map((item, n) => <li key={n}>{item.map(block)}</li>);

      return node.ordered ? (
        <ol key={k} start={node.start}>
          {items}
        </ol>
      ) : (
        <ul key={k}>{items}</ul>
      );
    }

    case 'rule':
      return <hr key={k} />;
  }
}

export function Markdown({ text }: { text: string }) {
  // The log re-renders on every agent event; a reply only changes when its text does.
  const blocks = useMemo(() => parseMarkdown(text).map(block), [text]);

  return <div className="md">{blocks}</div>;
}
