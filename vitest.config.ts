import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Declare the `integration` tag (strictTags is on by default, so a tag used
    // in a test must be defined here). The tag is the sole opt-in switch:
    //   npm test               → unit only    (vitest --tagsFilter='!integration')
    //   npm run test:integration → integration (vitest --tagsFilter=integration)
    tags: [
      {
        name: 'integration',
        description: 'Bridge tests against a real Music.app (opt-in; needs the test playlist set up).',
      },
    ],
  },
});
