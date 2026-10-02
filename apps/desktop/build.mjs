// Bundles each process for its runtime. Core stays external to the host so it
// resolves to the workspace build, native better-sqlite3 included.
import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

const shared = { bundle: true, target: 'es2022', logLevel: 'warning', outdir: 'dist' };

await mkdir('dist/renderer', { recursive: true });
await Promise.all([
  build({
    ...shared,
    entryPoints: ['src/host/index.ts'],
    entryNames: 'host',
    platform: 'node',
    format: 'esm',
    packages: 'external',
  }),
  build({
    ...shared,
    entryPoints: ['src/main/main.ts'],
    platform: 'node',
    format: 'esm',
    external: ['electron'],
  }),
  // A sandboxed preload must be CommonJS.
  build({
    ...shared,
    entryPoints: ['src/main/preload.ts'],
    outExtension: { '.js': '.cjs' },
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...shared,
    entryPoints: ['src/renderer/app.tsx'],
    outdir: 'dist/renderer',
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  }),
  copyFile('src/renderer/index.html', 'dist/renderer/index.html'),
  copyFile('src/renderer/app.css', 'dist/renderer/app.css'),
]);
