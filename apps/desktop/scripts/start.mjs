// Launches the app. On macOS it runs from a copy of Electron.app renamed to
// Selecta, so the menu bar, the Dock and the Automation prompt say Selecta.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
// Run from Node, the electron package exports its executable's path.
const electron = require('electron');

function bundle() {
  const dir = join(root, '.dev');
  const app = join(dir, 'Selecta.app');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const stamp = JSON.stringify({
    electron: require('electron/package.json').version,
    identity: [pkg.productName, pkg.version, pkg.build],
    icon: createHash('sha256')
      .update(readFileSync(join(root, 'assets/icon.svg')))
      .digest('hex'),
  });
  const stampFile = join(dir, 'stamp.json');

  try {
    if (readFileSync(stampFile, 'utf8') === stamp) return app;
  } catch {}

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const electronApp = join(electron, '../../..');

  // A clone costs no disk on APFS; plain copy elsewhere.
  try {
    execFileSync('cp', ['-cR', electronApp, app], { stdio: 'ignore' });
  } catch {
    rmSync(app, { recursive: true, force: true });
    execFileSync('cp', ['-R', electronApp, app]);
  }

  const plist = join(app, 'Contents/Info.plist');
  const set = (key, value) => execFileSync('plutil', ['-replace', key, '-string', value, plist]);

  // The identity electron-builder will read when the app is packaged.
  const { appId, copyright, mac } = pkg.build;

  set('CFBundleName', pkg.productName);
  set('CFBundleDisplayName', pkg.productName);
  // Its own ID, so a dev run never shares settings or permissions with a release.
  set('CFBundleIdentifier', `${appId}.dev`);
  set('CFBundleShortVersionString', pkg.version);
  set('CFBundleVersion', pkg.version);
  set('NSHumanReadableCopyright', copyright);
  set('LSApplicationCategoryType', mac.category);

  for (const [key, value] of Object.entries(mac.extendInfo)) set(key, value);

  let drawn = true;

  try {
    execFileSync(
      electron,
      [join(root, 'scripts/icon.mjs'), join(app, 'Contents/Resources/electron.icns')],
      { stdio: 'inherit' },
    );
  } catch {
    drawn = false;
    console.error('Could not draw the Selecta icon; the Dock keeps Electron’s this time.');
  }

  // Editing Info.plist breaks Electron's signature, which macOS then refuses to run.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' });

  // No stamp without the icon, so the next launch tries again.
  if (drawn) writeFileSync(stampFile, stamp);

  return app;
}

const binary =
  process.platform === 'darwin' ? join(bundle(), 'Contents/MacOS', 'Electron') : electron;
const child = spawn(binary, [root, ...process.argv.slice(2)], { stdio: 'inherit' });

child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
