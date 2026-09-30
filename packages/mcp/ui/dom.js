// Host renderers may inject global CSS. Keep the card in a shadow tree while
// inheriting the standard MCP theme variables through its host element.
export const host = document.createElement('div');
host.dataset.palette = 'host';
document.body.append(host);
export const ui = host.attachShadow({ mode: 'open' });
const template = document.getElementById('selecta-template');

ui.append(template.content.cloneNode(true));
template.remove();
export const el = (id) => ui.getElementById(id);
