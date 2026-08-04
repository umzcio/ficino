/**
 * Playwright global setup (plan 037): seed the plan-036 fixtures once before
 * any spec runs. Idempotent (see ensureFeed.ts), so running it on every
 * invocation is harmless locally and guarantees fixture presence on a fresh
 * CI database regardless of spec execution order (several specs seed in
 * their own beforeAll, but e.g. r2_sections_11_13's tag-flow test also
 * benefits and does not seed itself).
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureFeedFixtures } from './ensureFeed'

export default function globalSetup(): void {
  // tests/screenshots/ is gitignored, so a fresh checkout (CI) has no such
  // dir and page.screenshot({ path }) throws ENOENT. Specs write there via
  // spec-file-relative paths (join(__dirname, '..', 'screenshots')); create
  // the dir once here so no spec has to.
  mkdirSync(resolve(__dirname, '..', '..', 'screenshots'), { recursive: true })
  ensureFeedFixtures()
}
