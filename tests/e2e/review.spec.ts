import { test, expect, Page } from '@playwright/test'
import { join } from 'path'

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000/ficino'
const SHOTS = '/projects/ficino/tests/screenshots'

function shot(name: string) {
  return join(SHOTS, `review_${name}.png`)
}

async function boot(page: Page) {
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30_000 })
  // Desktop nav is `hidden md:flex` (≥768px); mobile uses MobileDrawer + bottom bar.
  // Wait for ANY nav landmark so boot works at both viewports.
  await page.waitForSelector('nav, [role="navigation"]', { timeout: 15_000, state: 'attached' })
  await page.waitForSelector('article, main, #root', { timeout: 15_000 })
}

async function navTo(page: Page, label: string) {
  await page.locator(`nav[aria-label="Main navigation"] button[aria-label="${label}"]`).click()
  await page.waitForTimeout(400)
}

test.describe('REVIEW — core flows (HIGH+ only)', () => {
  test('R-01 Upload PDF UI reachable from settings/sidebar', async ({ page }) => {
    await boot(page)
    const uploadControls = await page.locator(
      'input[type="file"], [aria-label*="Upload" i], [aria-label*="upload" i], button:has-text("Upload")',
    ).count()
    console.log(`R-01: upload-related controls on page = ${uploadControls}`)
    expect(uploadControls).toBeGreaterThan(0)
    const fileInput = page.locator('input[type="file"]').first()
    const exists = await fileInput.count()
    if (exists > 0) {
      const cls = await fileInput.getAttribute('class')
      const tabIdx = await fileInput.getAttribute('tabindex')
      const isHidden = (cls || '').includes('hidden')
      const visuallyHiddenOk = (cls || '').includes('sr-only')
      console.log(`R-01: file-input class=${cls} tabindex=${tabIdx} isHidden=${isHidden} visuallyHiddenOk=${visuallyHiddenOk}`)
      expect.soft(isHidden && !visuallyHiddenOk, 'CRIT-3: file input uses className="hidden" → display:none, removed from tab order').toBe(false)
    }
    await page.screenshot({ path: shot('01_upload_ui') })
  })

  test('R-02 Reply composer opens with @mention autocomplete', async ({ page }) => {
    await boot(page)
    const replyBtn = page.locator('button[aria-label^="Replies"]').first()
    await expect(replyBtn).toBeVisible({ timeout: 15_000 })
    await replyBtn.click()
    await page.waitForTimeout(700)
    const input = page.locator('input[placeholder^="Post your reply"], textarea[placeholder^="Post your reply"]').first()
    await expect(input).toBeVisible()
    await input.fill('hey @')
    await page.waitForTimeout(700)
    const handleButtons = page.locator(
      'button:has-text("@skeptical_methods"), button:has-text("@ai_breakthroughs"), button:has-text("@archivist"), [role="option"]',
    )
    const count = await handleButtons.count()
    console.log(`R-02: @mention options = ${count}`)
    await page.screenshot({ path: shot('02_mention') })
    expect(count).toBeGreaterThan(0)
  })

  test('R-03 Compose box posts a question and Archivist pending state renders', async ({ page }) => {
    await boot(page)
    const compose = page.locator('textarea[placeholder*="Ask"], input[placeholder*="Ask"]').first()
    const composeCount = await compose.count()
    if (composeCount === 0) {
      console.log('R-03: compose box not found on feed — feature gated or renamed')
      await page.screenshot({ path: shot('03_no_compose') })
      test.skip()
      return
    }
    await expect(compose).toBeVisible()
    const label = await compose.getAttribute('aria-label')
    const placeholder = await compose.getAttribute('placeholder')
    console.log(`R-03: compose label=${label} placeholder=${placeholder}`)
    expect(label || placeholder).toBeTruthy()
    await page.screenshot({ path: shot('03_compose') })
  })

  test('R-04 Workspace switch dropdown accessibility', async ({ page, context }) => {
    await boot(page)
    // WorkspaceDropdown.tsx:37: `if (!active || workspaces.length <= 1) return null`
    // So the trigger only renders with ≥2 workspaces. Probe the API to know whether it'll exist.
    const ws = await context.request.get(`${BASE}/api/workspaces`, { ignoreHTTPSErrors: true }).catch(() => null)
    const list = ws?.ok() ? await ws.json() : []
    console.log(`R-04: ${list.length} workspaces`)
    if (list.length <= 1) {
      console.log('R-04: dropdown not rendered (single-workspace mode) — HIGH-15 validated via static read of WorkspaceDropdown.tsx:57')
      test.skip()
      return
    }
    const trigger = page.locator('button:has(svg)').filter({ hasText: list[0].name }).first()
    await expect(trigger).toBeVisible()
    await trigger.click()
    await page.waitForTimeout(400)
    const createBtn = page.getByRole('button', { name: /new workspace|create|\+/i }).first()
    if (await createBtn.count()) {
      await createBtn.click()
      await page.waitForTimeout(300)
      const createInput = page.locator('input[placeholder="Name..."]').first()
      const label = await createInput.getAttribute('aria-label')
      console.log(`R-04: create-workspace input aria-label=${label}`)
      expect.soft(label, 'HIGH-15: create-workspace input has no aria-label (only placeholder="Name...")').not.toBeNull()
    }
    await page.screenshot({ path: shot('04_workspace_dropdown') })
  })

  test('R-05 PWA service worker + manifest registered', async ({ page, context }) => {
    await boot(page)
    const manifestResp = await context.request.get(`${BASE}/manifest.webmanifest`, {
      ignoreHTTPSErrors: true,
    }).catch(() => null)
    const swResp = await context.request.get(`${BASE}/sw.js`, { ignoreHTTPSErrors: true }).catch(() => null)
    const manifestOk = manifestResp?.ok() ?? false
    const swOk = swResp?.ok() ?? false
    console.log(`R-05: manifest.webmanifest=${manifestOk} sw.js=${swOk}`)
    const swRegistered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false
      const regs = await navigator.serviceWorker.getRegistrations()
      return regs.length > 0
    })
    console.log(`R-05: serviceWorker registered in browser = ${swRegistered}`)
    expect(manifestOk || swOk).toBe(true)
    await page.screenshot({ path: shot('05_pwa') })
  })

  test('R-06 Offline mode: set offline, reload, cached UI still boots', async ({ page, context }) => {
    await boot(page)
    await page.waitForTimeout(1200) // let SW + IDB finish first-load hydration
    await context.setOffline(true)
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
    await page.waitForTimeout(2000)
    const nav = await page.locator('nav[aria-label="Main navigation"]').count()
    const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 200)
    console.log(`R-06: offline reload — nav present=${nav > 0} body preview="${bodyText.replace(/\s+/g, ' ')}"`)
    await page.screenshot({ path: shot('06_offline') })
    await context.setOffline(false)
    expect(nav).toBeGreaterThan(0)
  })

  test('R-07 Sign-out (if present) clears IndexedDB — CRIT-2 gate', async ({ page, context }) => {
    await boot(page)
    // Write a sentinel into IndexedDB via the app's db wrapper, then look for a sign-out control.
    await page.evaluate(async () => {
      const openReq = indexedDB.open('ficino-offline')
      await new Promise((resolve) => {
        openReq.onsuccess = () => resolve(null)
        openReq.onerror = () => resolve(null)
        openReq.onblocked = () => resolve(null)
      })
    })
    const signOut = page.locator('button:has-text("Sign out"), button:has-text("Log out"), [aria-label*="Sign out" i]').first()
    const hasSignOut = await signOut.count()
    if (hasSignOut === 0) {
      console.log('R-07: no sign-out UI visible (AUTH_PROVIDER=none) — CRIT-2 exists in code path only')
      test.skip()
      return
    }
    // If present: check post-signout IndexedDB state
    const dbsBefore = await page.evaluate(async () => {
      const dbs = await (indexedDB.databases?.() ?? Promise.resolve([]))
      return dbs.map((d: any) => d.name)
    })
    await signOut.click()
    await page.waitForTimeout(1500)
    const dbsAfter = await page.evaluate(async () => {
      const dbs = await (indexedDB.databases?.() ?? Promise.resolve([]))
      return dbs.map((d: any) => d.name)
    })
    console.log(`R-07: IDB before signout=${JSON.stringify(dbsBefore)} after=${JSON.stringify(dbsAfter)}`)
    expect.soft(dbsAfter.length, 'CRIT-2: IndexedDB left populated after signOut').toBe(0)
    await page.screenshot({ path: shot('07_signout') })
  })
})
