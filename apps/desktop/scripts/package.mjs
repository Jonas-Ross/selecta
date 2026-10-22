// Packages Selecta.app with its own Node, core and MCP server, so it runs on a Mac
// with nothing else installed. Run `npm run build` at the root first.
// Usage: npm run package -w @selecta/desktop [-- --arch arm64|x64]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const repo = join(root, '../..');
const stage = join(root, '.package');
const arch = process.argv.includes('--arch')
  ? process.argv[process.argv.indexOf('--arch') + 1]
  : process.arch;

// Pinned with its checksums from nodejs.org, so a build ships exactly this Node.
const NODE = {
  version: '22.23.4',
  sha256: {
    arm64: 'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428',
    x64: 'efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819',
  },
};

if (!(arch in NODE.sha256)) throw new Error(`No pinned Node for ${arch}; use arm64 or x64.`);

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const log = (message) => process.stderr.write(`package: ${message}\n`);

async function node(dest) {
  const name = `node-v${NODE.version}-darwin-${arch}`;
  const cache = join(root, '.cache');
  const tarball = join(cache, `${name}.tar.gz`);
  let bytes = await readFile(tarball).catch(() => undefined);

  const fresh = !bytes;

  if (fresh) {
    log(`downloading Node ${NODE.version} for ${arch}`);

    const response = await fetch(`https://nodejs.org/dist/v${NODE.version}/${name}.tar.gz`);

    if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);

    bytes = Buffer.from(await response.arrayBuffer());
  }

  const sum = createHash('sha256').update(bytes).digest('hex');

  if (sum !== NODE.sha256[arch])
    throw new Error(`${name}.tar.gz has checksum ${sum}, not the pinned one`);

  if (fresh) {
    await mkdir(cache, { recursive: true });
    await writeFile(tarball, bytes);
  }

  execFileSync('tar', ['-xzf', tarball, '-C', cache, `${name}/bin/node`]);
  await cp(join(cache, name, 'bin/node'), dest);
}

// Core's version.ts reads its package.json at runtime, which a bundle leaves behind.
const coreVersion = JSON.parse(
  await readFile(join(repo, 'packages/core/package.json'), 'utf8'),
).version;
const inlineVersion = {
  name: 'inline-version',
  setup(builder) {
    builder.onLoad(
      { filter: /packages[\\/]core[\\/](src|dist)[\\/]version\.[jt]s$/ },
      async () => ({
        contents: `export const APP_VERSION = ${JSON.stringify(coreVersion)};`,
        loader: 'js',
      }),
    );
  },
};

// The one native module, copied beside the bundles with its prebuilt binary. Not
// under node_modules, which electron-builder leaves out of extraResources.
const sqliteBeside = {
  name: 'sqlite-beside',
  setup(builder) {
    builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({
      path: './better-sqlite3/lib/index.js',
      external: true,
    }));
  },
};

async function bundle(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    logLevel: 'warning',
    plugins: [inlineVersion, sqliteBeside],
    // CommonJS dependencies inside an ESM bundle still call require.
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  });
}

await rm(stage, { recursive: true, force: true });

const app = join(stage, 'app');
const core = join(stage, 'core');
const sqlite = join(core, 'better-sqlite3');

log('staging the app and its core');
await mkdir(app, { recursive: true });
await mkdir(join(sqlite, 'prebuilds'), { recursive: true });
await Promise.all([
  cp(join(root, 'dist/main.js'), join(app, 'main.js')),
  cp(join(root, 'dist/preload.cjs'), join(app, 'preload.cjs')),
  cp(join(root, 'dist/renderer'), join(app, 'renderer'), { recursive: true }),
  writeFile(
    join(app, 'package.json'),
    JSON.stringify({
      name: 'selecta',
      productName: pkg.productName,
      version: pkg.version,
      description: pkg.description,
      type: 'module',
      main: 'main.js',
    }),
  ),
  bundle(join(root, 'src/host/index.ts'), join(core, 'host.js')),
  bundle(join(repo, 'packages/mcp/dist/index.js'), join(core, 'mcp.js')),
  cp(join(repo, 'packages/mcp/dist/ui'), join(core, 'ui'), { recursive: true }),
  writeFile(join(core, 'package.json'), JSON.stringify({ type: 'module' })),
  ...['package.json', 'LICENSE', 'lib'].map((file) =>
    cp(join(repo, 'node_modules/better-sqlite3', file), join(sqlite, file), { recursive: true }),
  ),
  cp(
    join(repo, `node_modules/better-sqlite3/prebuilds/darwin-${arch}.node`),
    join(sqlite, `prebuilds/darwin-${arch}.node`),
  ),
  node(join(core, 'node')),
]);

if (process.platform !== 'darwin') {
  log(`staged in ${stage}; only a Mac can build the app itself`);
  process.exit(0);
}

log('drawing the icon');
execFileSync(require('electron'), [join(root, 'scripts/icon.mjs'), join(stage, 'icon.icns')], {
  stdio: 'inherit',
});

log(`building Selecta.app for ${arch}`);
execFileSync(
  join(repo, 'node_modules/.bin/electron-builder'),
  ['--mac', `--${arch}`, '-c.electronVersion', require('electron/package.json').version],
  { cwd: root, stdio: 'inherit' },
);
log(`done: ${join(stage, 'out')}`);
