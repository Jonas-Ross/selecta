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

host.on('exit', (code) => {
  for (const call of pending.values()) call.reject(new Error('The Selecta core process stopped.'));

  pending.clear();

  if (!quitting)
    dialog.showErrorBox(
      'Selecta',
      `The core process stopped (exit code ${code}). Restart the app.`,
    );
});

host.on('error', (error) =>
  dialog.showErrorBox('Selecta', `Could not start Node for the core process: ${error.message}`),
);

ipcMain.handle('selecta:call', (_event, method: string, args: unknown) => {
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
