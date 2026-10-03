// The preload's bridge to the host: the renderer's only way out.
import type { SelectaApi } from '../shared/protocol.js';

declare global {
  interface Window {
    selecta: SelectaApi;
  }
}

export const { selecta } = window;
