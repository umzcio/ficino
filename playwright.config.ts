import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './tests/results',
  // Seeds the plan-036 fixtures (idempotently) once per run so specs never
  // depend on what happens to be in the database — see the file's header.
  globalSetup: './tests/e2e/helpers/globalSetup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3070/ficino/',
    ignoreHTTPSErrors: true,
    // 'on' captures a screenshot after every test (pass or fail). That's
    // expensive on disk and fragile for the Generate flow, which polls for
    // a long time (BUG-LIVE-02) — the teardown snapshot hangs until the
    // test timeout. only-on-failure keeps debugging signal
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
    {
      // CI gate project (plan 037): desktop viewport, fixture-runnable
      // subset only — the CI runner has no LLM/embed backend. Excluded:
      //   round9_core_flows — R9-01 waits on real upload processing
      //     (embeddings) and R9-02 expects a real archivist (LLM) reply.
      //   wave4_group_chat — uploadAndWaitComplete needs embeddings; the
      //     synthesis poll needs an LLM.
      //   R2-S16-09 — keyboard "." dispatches a REAL feed generation.
      // New specs land IN the gate by default; if a spec needs real
      // generation, exclude it here and record it in tests/e2e/SKIPS.md.
      name: 'ci',
      use: { viewport: { width: 1280, height: 800 } },
      testIgnore: [/round9_core_flows\.spec\.ts$/, /wave4_group_chat\.spec\.ts$/],
      grepInvert: /R2-S16-09/,
    },
  ],
});
