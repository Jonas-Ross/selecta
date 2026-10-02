// Electron main stays a pipe: a window, and the core host process behind it.
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { HostEvent } from '../shared/protocol.js';

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
let nextId = 1;
let window: BrowserWindow | undefined;
let quitting = false;

const host = spawn(process.env.SELECTA_NODE ?? 'node', [here('./host.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

createInterface({ input: host.stdout }).on('line', (line) => {
  const message = JSON.parse(line) as { id: number; result?: unknown; error?: string } | HostEvent;

  if ('event' in message) {
    window?.webContents.send('selecta:event', message);

    return;
  }

  const call = pending.get(message.id);

  pending.delete(message.id);

  if (message.error !== undefined) call?.reject(new Error(message.error));
  else call?.resolve(message.result);
});

let stopped: string | undefined;

// Spawn failure fires 'error' without 'exit', so both paths settle every call through here.
function stop(reason: string) {
  if (stopped !== undefined) return;

  stopped = reason;

  for (const call of pending.values()) call.reject(new Error(reason));

  pending.clear();

  if (!quitting) dialog.showErrorBox('Selecta', `${reason} Restart the app.`);
}

host.on('exit', (code) => stop(`The Selecta core process stopped (exit code ${code}).`));
host.on('error', (error) => stop(`Could not start Node for the core process: ${error.message}.`));
// A write racing the failure gets EPIPE; stop() already reports it.
host.stdin.on('error', () => {});

ipcMain.handle('selecta:call', (_event, method: string, args: unknown) => {
  if (stopped !== undefined) return Promise.reject(new Error(stopped));

  const id = nextId++;

  host.stdin.write(`${JSON.stringify({ id, method, args })}\n`);

  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
});

app.whenReady().then(() => {
  window = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Selecta',
    webPreferences: {
      preload: here('./preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.loadFile(here('./renderer/index.html'));
});

app.on('before-quit', () => {
  quitting = true;
  host.stdin.end();
});

app.on('window-all-closed', () => app.quit());
