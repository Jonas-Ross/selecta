import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSource = fileURLToPath(new URL('./packages/core/src/', import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run core from source, so a test and the server it drives share one
    // copy of each module instead of mixing src and dist.
    alias: [{ find: /^@selecta\/core\/(.*)\.js$/, replacement: `${coreSource}$1.ts` }],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // Blocks live network access from every test (see the file header).
    setupFiles: ['packages/core/test/network-guard.ts'],
    // Declare the `integration` tag (strictTags is on by default, so a tag used
    // in a test must be defined here). The tag is the sole opt-in switch:
    //   npm test               → unit only    (vitest --tags-filter='!integration')
    //   npm run test:integration → integration (vitest --tags-filter=integration)
    tags: [
      {
        name: 'integration',
        description:
          'Bridge tests against a real Music.app (opt-in; needs the test playlist set up).',
      },
    ],
  },
});
