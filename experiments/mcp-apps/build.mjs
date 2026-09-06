import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
const result = await build({
  entryPoints: [new URL('./widget.js', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'iife',
  minify: true,
});
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px system-ui;margin:16px;color:CanvasText;background:Canvas}h2{font-size:18px}label{display:block;padding:12px 0;border-bottom:1px solid GrayText}button{padding:9px;margin:8px 4px 0 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}input{margin-right:10px}</style></head><body><h2>Selecta fixture picker</h2><p>Fake tracks only. Nothing accesses or changes your library.</p><div id="tracks"></div><button id="send" disabled>Send selection to agent</button><button id="context" disabled>Update context</button><button id="echo" disabled>Read-only echo</button><button id="error" disabled>Controlled error</button><pre id="status" role="status">Waiting for host and tool result…</pre><details><summary>Host theme and size</summary><pre id="host"></pre></details><script>${result.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;

await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await writeFile(new URL('./dist/widget.html', import.meta.url), html);
