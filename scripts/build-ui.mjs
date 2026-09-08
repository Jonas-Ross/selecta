// Bundle the SDK and widget together: no CDN, external assets or runtime server.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
let widgetHtml = await readFile(new URL('../ui/playlist-draft.html', import.meta.url), 'utf8');

// Each stylesheet fills its own placeholder so cascade order stays explicit.
for (const sheet of ['pulse', 'setlist', 'timeline'])
  widgetHtml = widgetHtml.replace(
    `/*__${sheet.toUpperCase()}__*/`,
    await readFile(new URL(`../ui/${sheet}.css`, import.meta.url), 'utf8'),
  );

const result = await build({
  entryPoints: ['ui/playlist-draft.js'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
});

await mkdir(new URL('../dist/ui/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../dist/ui/playlist-draft.html', import.meta.url),
  widgetHtml.replace('/*__APP__*/', () =>
    result.outputFiles[0].text.replaceAll('</script', '<\\/script'),
  ),
);
