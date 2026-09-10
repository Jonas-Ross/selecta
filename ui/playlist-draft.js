// @ts-check
import { host, ui, el } from './dom.js';
import './pulse.js';
import { observeSize } from './resize.js';
import { App, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { createDraftController } from './draft-controller.js';

const app = new App(
  { name: 'Selecta playlist draft', version: '1.0.0' },
  {},
  { autoResize: false },
);
// The fixed template supplies these controls; fail at wiring if an ID is missing.
/**
 * @template {keyof import('./draft-controller.js').DraftElements} K
 * @param {K} id
 * @returns {import('./draft-controller.js').DraftElements[K]}
 */
const draftElement = (id) => {
  const element = el(id);

  if (!element) throw new Error(`Missing draft control: ${id}`);

  return /** @type {import('./draft-controller.js').DraftElements[K]} */ (element);
};

await createDraftController(app, {
  host,
  ui,
  el: draftElement,
  observeSize,
  applyHostStyleVariables,
}).connect();
