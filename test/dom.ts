// Minimal DOM stand-in for the card's view modules: enough surface to build
// rows and timeline blocks and read back what they rendered, no browser.
export class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  classes = new Set<string>();
  classList = {
    toggle: (name: string, force?: boolean) => {
      if (force ?? !this.classes.has(name)) this.classes.add(name);
      else this.classes.delete(name);
    },
  };
  ownerDocument = { createElement: (tag: string) => new Element(tag) };
  scrollTop = 0;
  scrollLeft = 0;
  disabled = false;
  inert = false;
  hidden = true;
  checked = false;
  textContent = '';
  className = '';
  title = '';
  value = '';
  type = '';
  onclick = () => {};
  onchange = () => {};
  constructor(readonly tag = 'div') {}
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  /** Descendants matching a comma-separated tag list, in document order. */
  querySelectorAll(selector = 'input, button'): Element[] {
    const tags = selector.split(',').map((tag) => tag.trim());

    return this.children.flatMap((node) => [
      ...(tags.includes(node.tag) ? [node] : []),
      ...node.querySelectorAll(selector),
    ]);
  }
}

/** An `el(id)` lookup that creates one Element per id on first use. */
export function elementLookup() {
  const nodes = new Map<string, Element>();

  return (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Element());

    return nodes.get(id)!;
  };
}
