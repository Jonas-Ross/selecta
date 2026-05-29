import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Declare the `integration` tag (strictTags is on by default, so a tag used
    // in a test must be defined here). Integration tests are opt-in:
    //   npm test               → unit only       (vitest --tagsFilter='!integration')
    //   npm run test:integration → integration    (vitest --tagsFilter=integration)
    // They additionally self-skip unless SELECTA_INTEGRATION=1 (see the suite).
    tags: [
      {
        name: 'integration',
        description: 'Bridge tests against a real Music.app (opt-in; needs SELECTA_INTEGRATION=1).',
      },
    ],
  },
});
