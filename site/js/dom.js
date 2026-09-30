export const $ = (id) => document.getElementById(id);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);

  n.append(...kids);

  return n;
};

export const css = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
