import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 60_000,
  outputDir: 'test-results',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
