/**
 * Playwright global setup (plan 037): seed the plan-036 fixtures once before
 * any spec runs. Idempotent (see ensureFeed.ts), so running it on every
 * invocation is harmless locally and guarantees fixture presence on a fresh
 * CI database regardless of spec execution order (several specs seed in
 * their own beforeAll, but e.g. r2_sections_11_13's tag-flow test also
 * benefits and does not seed itself).
 */
import { ensureFeedFixtures } from './ensureFeed'

export default function globalSetup(): void {
  ensureFeedFixtures()
}
