// Children keyed by entry ID: reuse the node that already shows an entry,
// create the rest and move only the nodes that are out of place. Untouched
// nodes keep their focus, scroll position and running transitions.
export function reconcileChildren(container, entries, { create, update }) {
  const existing = new Map();

  for (const node of container.children) existing.set(node.dataset.entryId, node);

  const nodes = entries.map((entry, index) => {
    let node = existing.get(entry.entry_id);

    if (node) existing.delete(entry.entry_id);
    else {
      node = create();
      node.dataset.entryId = entry.entry_id;
    }

    update(node, entry, index);

    return node;
  });

  for (const node of existing.values()) node.remove();

  nodes.forEach((node, index) => {
    if (container.children[index] !== node)
      container.insertBefore(node, container.children[index] ?? null);
  });
}

export function element(document, tag, className) {
  const node = document.createElement(tag);

  node.className = className;

  return node;
}
