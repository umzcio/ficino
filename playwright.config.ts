import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './tests/results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'https://ficino.local/ficino',
    ignoreHTTPSErrors: true,
    // 'on' captures a screenshot after every test (pass or fail). That's
    // expensive on disk and fragile for the Generate flow which holds an
    // SSE connection open for ~28s (BUG-LIVE-02) — the teardown snapshot
    // hangs until the test timeout. only-on-failure keeps debugging signal
    // without the fragility.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'desktop',
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 } },
    },
  ],
});
