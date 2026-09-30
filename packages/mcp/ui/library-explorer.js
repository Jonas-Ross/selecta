import { App, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { host, el } from './dom.js';
import { observeSize } from './resize.js';
import { connectExplorer } from './explorer-controller.js';

const app = new App(
  { name: 'Selecta library explorer', version: '1.0.0' },
  {},
  { autoResize: false },
);

await connectExplorer(app, { host, el, observeSize, applyHostStyleVariables });
