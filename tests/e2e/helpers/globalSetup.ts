/**
 * Playwright global setup (plan 037): seed the plan-036 fixtures once before
 * any spec runs. Idempotent (see ensureFeed.ts), so running it on every
 * invocation is harmless locally and guarantees fixture presence on a fresh
 * CI database regardless of spec execution order (several specs seed in
 * their own beforeAll, but e.g. r2_sections_11_13's tag-flow test also
 * benefits and does not seed itself).
 *
 * With E2E_SEED_SAMPLE_PDF=1 (`scripts/e2e-stack.sh full`, plan 06) it also
 * ingests one real paper: the full suite's R9-02 needs at least one real
 * chunk in the corpus, and the fixture paper has none.
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FullConfig } from '@playwright/test'
import { ensureFeedFixtures } from './ensureFeed'
import { seedSamplePaper } from './seedSamplePaper'

export default async function globalSetup(config: FullConfig): Promise<void> {
  // tests/screenshots/ is gitignored, so a fresh checkout (CI) has no such
  // dir and page.screenshot({ path }) throws ENOENT. Specs write there via
  // spec-file-relative paths (join(__dirname, '..', 'screenshots')); create
  // the dir once here so no spec has to.
  mkdirSync(resolve(__dirname, '..', '..', 'screenshots'), { recursive: true })
  ensureFeedFixtures()
  if (process.env.E2E_SEED_SAMPLE_PDF === '1') {
    const baseURL = config.projects[0]?.use.baseURL
    if (!baseURL) throw new Error('globalSetup: no baseURL to seed the sample paper against')
    await seedSamplePaper(baseURL)
  }
}
