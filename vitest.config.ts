import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default `npm test` is the fast unit suite — no Music.app required.
    // Integration tests live in test/integration/ and run via `npm run test:integration`
    // (and only with SELECTA_INTEGRATION=1 set; see test/integration/bridge.test.ts).
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'node_modules/**', 'dist/**'],
  },
});
