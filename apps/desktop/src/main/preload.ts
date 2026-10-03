// The renderer's only door out: two calls, no Node.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { HostEvent, SelectaApi } from '../shared/protocol.js';

const api: SelectaApi = {
  // Electron wraps a rejected handler's message in its own prefix; screens show the host's words.
  call: (method, ...args) =>
    ipcRenderer.invoke('selecta:call', method, args[0]).catch((error: Error) => {
      throw new Error(
        error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),
      );
    }),
  on(listener) {
    const handler = (_event: IpcRendererEvent, message: HostEvent) => listener(message);

    ipcRenderer.on('selecta:event', handler);

    return () => ipcRenderer.removeListener('selecta:event', handler);
  },
};

contextBridge.exposeInMainWorld('selecta', api);
