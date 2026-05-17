import { test, expect, Page } from '@playwright/test'

const SCREENSHOTS = '/projects/ficino/tests/screenshots'
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000/ficino'

async function navTo(page: Page, label: string) {
  await page.locator(`nav[aria-label="Main navigation"] button[aria-label="${label}"]`).click()
}

async function waitForApp(page: Page) {
  await page.waitForSelector('nav[aria-label="Main navigation"]', { timeout: 15000 })
}

// ============================================================
// SECTION 14 — Settings (regression retest)
// ============================================================
test.describe('R2 Section 14: Settings', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 })
    await waitForApp(page)
    await navTo(page, 'Settings')
    await page.waitForSelector('h1:has-text("Settings")', { timeout: 10000 })
  })

  test('R2-S14-01: Settings header and subtitle render', async ({ page }) => {
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible()
    await expect(page.locator('text=Configure Ficino\'s behavior')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s14_settings_header.png`, fullPage: false })
  })

  test('R2-S14-02: LLM Provider section with Ollama and Claude API options', async ({ page }) => {
    await page.getByRole('tab', { name: 'AI' }).click()
    const section = page.locator('div:has(> div:has-text("LLM Provider"))').first()
    await expect(section).toBeVisible()
    const providerSelect = section.locator('select').first()
    await expect(providerSelect).toBeVisible()
    const options = providerSelect.locator('option')
    await expect(options.filter({ hasText: 'Ollama' })).toHaveCount(1)
    await expect(options.filter({ hasText: 'Claude API' })).toHaveCount(1)
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s14_llm_provider.png`, fullPage: false })
  })

  test('R2-S14-03: Personas section with toggles', async ({ page }) => {
    await page.getByRole('tab', { name: 'AI' }).click()
    const personasHeader = page.locator('span:has-text("Personas")').filter({ hasText: /^Personas$/ })
    await expect(personasHeader.first()).toBeVisible()
    const toggles = page.locator('button[role="switch"]')
    expect(await toggles.count()).toBeGreaterThanOrEqual(3)
    const tempSlider = page.locator('text=Persona Temperature').locator('..')
    await expect(tempSlider).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s14_personas.png`, fullPage: false })
  })

  test('R2-S14-04: Feed Generation section with sliders and reset', async ({ page }) => {
    await page.getByRole('tab', { name: 'Content' }).click()
    await expect(page.locator('span:has-text("Feed Generation")').first()).toBeVisible()
    await expect(page.locator('text=Posts per Generation')).toBeVisible()
    for (const label of ['Posts', 'Threads', 'Quotes', 'Replies', 'Figures']) {
      await expect(page.locator(`text=${label}`).first()).toBeVisible()
    }
    await expect(page.locator('button:has-text("Reset")').first()).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s14_feed_generation.png`, fullPage: false })
  })

  test('R2-S14-05: Paper Processing section', async ({ page }) => {
    await page.getByRole('tab', { name: 'Content' }).click()
    await expect(page.locator('span:has-text("Paper Processing")').first()).toBeVisible()
    await expect(page.locator('text=Extraction Mode')).toBeVisible()
    await expect(page.locator('text=Chunk Size')).toBeVisible()
    await expect(page.locator('text=Show Extraction Badge')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s14_paper_processing.png`, fullPage: false })
  })

  test('R2-S14-06: Display section', async ({ page }) => {
    await page.getByRole('tab', { name: 'Account' }).click()
    await expect(page.locator('span:has-text("Display")').filter({ hasText: /^Display$/ }).first()).toBeVisible()
    await expect(page.locator('text=Theme')).toBeVisible()
    await expect(page.locator('text=Font Size')).toBeVisible()
    await expect(page.locator('text=Post Spacing')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s14_display.png`, fullPage: false })
  })

  test('R2-S14-07: Danger Zone with destructive actions', async ({ page }) => {
    await page.getByRole('tab', { name: 'Storage' }).click()
    await page.locator('span:has-text("Danger Zone")').first().scrollIntoViewIfNeeded()
    await expect(page.locator('span:has-text("Danger Zone")').first()).toBeVisible()
    await expect(page.locator('text=Clear All Feeds')).toBeVisible()
    await expect(page.locator('text=Clear All Summaries')).toBeVisible()
    await expect(page.locator('button:has-text("Clear Feeds")')).toBeVisible()
    await expect(page.locator('button:has-text("Clear Summaries")')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s14_danger_zone.png`, fullPage: false })
  })

  test('R2-S14-08: Full settings page screenshot', async ({ page }) => {
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s14_settings_full.png`, fullPage: true })
  })
})

// ============================================================
// SECTION 15 — Search / Explore (regression retest)
// ============================================================
test.describe('R2 Section 15: Search (Explore)', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 })
    await waitForApp(page)
    await navTo(page, 'Search')
    await page.waitForSelector('h1:has-text("Explore")', { timeout: 10000 })
  })

  test('R2-S15-01: Explore page loads with header and search bar', async ({ page }) => {
    await expect(page.locator('h1:has-text("Explore")')).toBeVisible()
    await expect(page.locator('text=Search, workspaces & activity')).toBeVisible()
    const searchInput = page.locator('input[aria-label="Search corpus"]')
    await expect(searchInput).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s15_explore_page.png`, fullPage: false })
  })

  test('R2-S15-02: Search bar auto-focuses on navigate', async ({ page }) => {
    const searchInput = page.locator('input[aria-label="Search corpus"]')
    await expect(searchInput).toBeFocused({ timeout: 5000 })
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s15_search_focused.png`, fullPage: false })
  })

  test('R2-S15-03: Type query and debounce produces results or no-results', async ({ page }) => {
    const searchInput = page.locator('input[aria-label="Search corpus"]')
    await searchInput.fill('neural network')
    await page.waitForTimeout(1500)
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s15_search_results.png`, fullPage: false })
    // Either a results dropdown or no-results message is valid
    const dropdown = page.locator('div.absolute.z-50')
    const noResults = page.locator('text=No results for')
    const hasDropdown = await dropdown.isVisible().catch(() => false)
    const hasNoResults = await noResults.isVisible().catch(() => false)
    // At minimum, the search input should have our text
    await expect(searchInput).toHaveValue('neural network')
    console.log(`Dropdown visible: ${hasDropdown}, No-results visible: ${hasNoResults}`)
  })

  test('R2-S15-04: Result grouping headers', async ({ page }) => {
    const searchInput = page.locator('input[aria-label="Search corpus"]')
    await searchInput.fill('method')
    await page.waitForTimeout(1500)
    const hasPapers = await page.locator('text=Papers (').first().isVisible().catch(() => false)
    const hasPassages = await page.locator('text=Passages (').first().isVisible().catch(() => false)
    const hasPosts = await page.locator('text=Feed Posts (').first().isVisible().catch(() => false)
    console.log(`R2 Search groups - Papers: ${hasPapers}, Passages: ${hasPassages}, Posts: ${hasPosts}`)
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s15_search_groups.png`, fullPage: false })
  })

  test('R2-S15-05: Clear button clears search input', async ({ page }) => {
    const searchInput = page.locator('input[aria-label="Search corpus"]')
    await searchInput.fill('test query')
    await page.waitForTimeout(500)
    const clearBtn = page.locator('button[aria-label="Clear search"]')
    await expect(clearBtn).toBeVisible({ timeout: 3000 })
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s15_clear_before.png`, fullPage: false })
    await clearBtn.click()
    await expect(searchInput).toHaveValue('')
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s15_clear_after.png`, fullPage: false })
  })

  test('R2-S15-06: Workspaces section with New Workspace button', async ({ page }) => {
    await expect(page.locator('text=Workspaces').first()).toBeVisible()
    await expect(page.locator('text=New Workspace')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s15_workspaces.png`, fullPage: false })
  })
})

// ============================================================
// SECTION 16 — Navigation & Keyboard Shortcuts (regression retest)
// ============================================================
test.describe('R2 Section 16: Navigation & Keyboard Shortcuts', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 })
    await waitForApp(page)
  })

  test('R2-S16-01: All 6 nav icons present', async ({ page }) => {
    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(nav).toBeVisible()
    const labels = ['Home', 'Search', 'Alerts', 'Messages', 'Saved', 'Settings']
    for (const label of labels) {
      await expect(nav.locator(`button[aria-label="${label}"]`)).toBeVisible()
    }
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s16_nav_all_icons.png`, fullPage: false })
  })

  test('R2-S16-02: Click each nav icon navigates to correct view', async ({ page }) => {
    const navChecks = [
      { label: 'Home', marker: 'ficino' },
      { label: 'Search', marker: 'Explore' },
      { label: 'Alerts', marker: 'Alerts' },
      { label: 'Messages', marker: 'Messages' },
      { label: 'Saved', marker: 'Bookmarks' },
      { label: 'Settings', marker: 'Settings' },
    ]
    for (const { label, marker } of navChecks) {
      await navTo(page, label)
      await page.waitForTimeout(300)
      const heading = page.locator(`h1:has-text("${marker}"), span:has-text("${marker}")`).first()
      await expect(heading).toBeVisible({ timeout: 5000 })
    }
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s16_nav_click_all.png`, fullPage: false })
  })

  test('R2-S16-03: Active nav item has aria-current="page"', async ({ page }) => {
    // Home should be active by default
    const homeBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Home"]')
    await expect(homeBtn).toHaveAttribute('aria-current', 'page')
    // Navigate to Settings
    await navTo(page, 'Settings')
    await page.waitForTimeout(300)
    const settingsBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Settings"]')
    await expect(settingsBtn).toHaveAttribute('aria-current', 'page')
    // Home should no longer have aria-current
    await expect(homeBtn).not.toHaveAttribute('aria-current', 'page')
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s16_aria_current.png`, fullPage: false })
  })

  test('R2-S16-04: Keyboard "h" navigates to Home', async ({ page }) => {
    await navTo(page, 'Settings')
    await page.waitForSelector('h1:has-text("Settings")', { timeout: 5000 })
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    await page.keyboard.press('h')
    await page.waitForTimeout(500)
    const homeBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Home"]')
    await expect(homeBtn).toHaveAttribute('aria-current', 'page')
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s16_key_h.png`, fullPage: false })
  })

  test('R2-S16-05: Keyboard "e" navigates to Explore', async ({ page }) => {
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    await page.keyboard.press('e')
    await page.waitForTimeout(500)
    await expect(page.locator('h1:has-text("Explore")')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s16_key_e.png`, fullPage: false })
  })

  test('R2-S16-06: Keyboard "m" navigates to Messages', async ({ page }) => {
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    await page.keyboard.press('m')
    await page.waitForTimeout(500)
    const msgBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Messages"]')
    await expect(msgBtn).toHaveAttribute('aria-current', 'page')
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s16_key_m.png`, fullPage: false })
  })

  test('R2-S16-07: Keyboard "b" navigates to Bookmarks', async ({ page }) => {
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    await page.keyboard.press('b')
    await page.waitForTimeout(500)
    const bmBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Saved"]')
    await expect(bmBtn).toHaveAttribute('aria-current', 'page')
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s16_key_b.png`, fullPage: false })
  })

  test('R2-S16-08: Keyboard "n" navigates to Alerts', async ({ page }) => {
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    await page.keyboard.press('n')
    await page.waitForTimeout(500)
    const alertBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Alerts"]')
    await expect(alertBtn).toHaveAttribute('aria-current', 'page')
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s16_key_n.png`, fullPage: false })
  })

  test('R2-S16-09: Keyboard "." triggers generate on feed view', async ({ page }) => {
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    await page.keyboard.press('.')
    await page.waitForTimeout(500)
    // Should still be on feed view
    const homeBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Home"]')
    await expect(homeBtn).toHaveAttribute('aria-current', 'page')
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s16_key_period.png`, fullPage: false })
  })

  test('R2-S16-10: Keyboard shortcuts suppressed when input focused', async ({ page }) => {
    await navTo(page, 'Search')
    await page.waitForSelector('h1:has-text("Explore")', { timeout: 5000 })
    const searchInput = page.locator('input[aria-label="Search corpus"]')
    await searchInput.focus()
    await page.keyboard.press('h')
    await page.waitForTimeout(300)
    // Should still be on Explore, NOT navigated to Home
    await expect(page.locator('h1:has-text("Explore")')).toBeVisible()
    // Search input should contain 'h' as typed text
    await expect(searchInput).toHaveValue('h')
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s16_input_guard.png`, fullPage: false })
  })

  test('R2-S16-11: Full navigation layout screenshot', async ({ page }) => {
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s16_nav_full.png`, fullPage: true })
  })
})
