// Minimal DOM stand-in for the card's view modules: enough surface to build
// rows and timeline blocks and read back what they rendered, no browser.
export class Element {
  children: Element[] = [];
  parentNode: Element | null = null;
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
    for (const node of nodes) this.insertBefore(node, null);
  }
  /** Moves a node that already has a parent, as in a real DOM. */
  insertBefore(node: Element, reference: Element | null) {
    node.remove();
    const index = reference ? this.children.indexOf(reference) : this.children.length;

    this.children.splice(index, 0, node);
    node.parentNode = this;
  }
  remove() {
    if (!this.parentNode) return;

    const siblings = this.parentNode.children;

    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  /** Every input and button descendant, in document order. */
  controls(): Element[] {
    return this.children.flatMap((node) => [
      ...(['input', 'button'].includes(node.tag) ? [node] : []),
      ...node.controls(),
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
