// Renders assets/icon.svg into an .icns file with the app's own Electron, so the
// icon has one source, no image tool to install and no binary in the repo.
// Usage: electron scripts/icon.mjs <out.icns>
import { readFile, writeFile } from 'node:fs/promises';
import { app, BrowserWindow } from 'electron';

const svg = new URL('../assets/icon.svg', import.meta.url);
const icns = process.argv.at(-1);

// ICNS types holding PNG data, by pixel size; macOS scales 512 up for the
// largest Finder views.
const entries = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32],
  ['icp6', 64],
  ['ic12', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic13', 256],
  ['ic09', 512],
  ['ic14', 512],
];

function chunk(type, data) {
  const head = Buffer.alloc(8);

  head.write(type, 0, 'ascii');
  head.writeUInt32BE(data.length + 8, 4);

  return Buffer.concat([head, data]);
}

async function render() {
  app.dock?.hide();
  const window = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  const html = `<style>html,body{margin:0;background:transparent}svg{display:block;width:512px;height:512px}</style>${await readFile(svg, 'utf8')}`;

  await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);

  // Offscreen pages hand over frames, not capturePage. Early ones can be blank, so
  // take the first whose centre (inside the tile) is drawn.
  const image = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the icon never painted')), 10_000);
    const onPaint = (_event, _dirty, frame) => {
      const { width, height } = frame.getSize();
      const centre = frame.crop({ x: width >> 1, y: height >> 1, width: 1, height: 1 }).toBitmap();

      if (width < 512 || centre[3] !== 255)
        return void setTimeout(() => window.webContents.invalidate(), 50);

      clearTimeout(timer);
      window.webContents.off('paint', onPaint);
      resolve(frame);
    };

    window.webContents.on('paint', onPaint);
    window.webContents.invalidate();
  });

  const pngs = new Map();

  for (const [, size] of entries)
    pngs.set(size, image.resize({ width: size, height: size, quality: 'best' }).toPNG());

  await writeFile(
    icns,
    chunk('icns', Buffer.concat(entries.map(([type, size]) => chunk(type, pngs.get(size))))),
  );
}

// Awaiting ready at the top level of an ESM main stalls Electron's startup.
void app
  .whenReady()
  .then(render)
  .then(
    () => app.quit(),
    (error) => {
      console.error(error);
      app.exit(1);
    },
  );
