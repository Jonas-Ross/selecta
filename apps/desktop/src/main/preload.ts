// The renderer's only door out: two calls, no Node.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { HostEvent, SelectaApi } from '../shared/protocol.js';

const api: SelectaApi = {
  call: (method, ...args) => ipcRenderer.invoke('selecta:call', method, args[0]),
  on(listener) {
    const handler = (_event: IpcRendererEvent, message: HostEvent) => listener(message);

    ipcRenderer.on('selecta:event', handler);

    return () => ipcRenderer.removeListener('selecta:event', handler);
  },
};

contextBridge.exposeInMainWorld('selecta', api);
