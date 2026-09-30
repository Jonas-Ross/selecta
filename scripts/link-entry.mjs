// MCP clients are configured with <repo>/dist/index.js; keep that path working
// now the server builds inside packages/mcp.
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../dist/index.js', import.meta.url),
  "#!/usr/bin/env node\nimport '../packages/mcp/dist/index.js';\n",
  { mode: 0o755 },
);
