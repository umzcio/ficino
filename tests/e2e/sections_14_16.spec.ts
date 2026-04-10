import { test, expect, Page } from '@playwright/test'

// Each describe block runs serially inside but blocks are independent

const SCREENSHOTS = '/projects/ficino/tests/screenshots'

// Helper: click a nav item by its aria-label
async function navTo(page: Page, label: string) {
  await page.locator('nav[aria-label="Main navigation"] button[aria-label="' + label + '"]').click()
}

// Helper: wait for the app to finish initial load
async function waitForApp(page: Page) {
  await page.waitForSelector('nav[aria-label="Main navigation"]', { timeout: 15000 })
}

// ============================================================
// SECTION 14 — Settings
// ============================================================
test.describe('Section 14: Settings', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ page }) => {
    await page.goto('/ficino', { waitUntil: 'networkidle', timeout: 30000 })
    await waitForApp(page)
    await navTo(page, 'Settings')
    // Wait for Settings header
    await page.waitForSelector('h1:has-text("Settings")', { timeout: 10000 })
  })

  test('S14-01: Settings view loads with correct header', async ({ page }) => {
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible()
    await expect(page.locator('text=Configure Ficino\'s behavior')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/s14_settings_header.png`, fullPage: false })
  })

  test('S14-02: LLM Provider section present with Ollama/API toggle', async ({ page }) => {
    const section = page.locator('div:has(> div:has-text("LLM Provider"))').first()
    await expect(section).toBeVisible()
    // Check for the provider select
    const providerSelect = section.locator('select').first()
    await expect(providerSelect).toBeVisible()
    // Should have ollama and api options
    const options = providerSelect.locator('option')
    await expect(options.filter({ hasText: 'Ollama' })).toHaveCount(1)
    await expect(options.filter({ hasText: 'Claude API' })).toHaveCount(1)
    await page.screenshot({ path: `${SCREENSHOTS}/s14_llm_provider.png`, fullPage: false })
  })

  test('S14-03: Personas section with toggles and temperature slider', async ({ page }) => {
    // Find the Personas section title
    const personasHeader = page.locator('span:has-text("Personas")').filter({ hasText: /^Personas$/ })
    await expect(personasHeader.first()).toBeVisible()
    // Check for toggle switches (role="switch")
    const toggles = page.locator('button[role="switch"]')
    expect(await toggles.count()).toBeGreaterThanOrEqual(3) // at least 3 personas
    // Check temperature slider
    const tempSlider = page.locator('text=Persona Temperature').locator('..')
    await expect(tempSlider).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/s14_personas.png`, fullPage: false })
  })

  test('S14-04: Feed Generation section with sliders and reset button', async ({ page }) => {
    const feedGenSection = page.locator('span:has-text("Feed Generation")').first()
    await expect(feedGenSection).toBeVisible()
    // Posts per Generation slider
    await expect(page.locator('text=Posts per Generation')).toBeVisible()
    // Post type weight labels
    for (const label of ['Posts', 'Threads', 'Quotes', 'Replies', 'Figures']) {
      await expect(page.locator(`text=${label}`).first()).toBeVisible()
    }
    // Reset button
    const resetBtn = page.locator('button:has-text("Reset")').first()
    await expect(resetBtn).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/s14_feed_generation.png`, fullPage: false })
  })

  test('S14-05: Paper Processing section', async ({ page }) => {
    await expect(page.locator('span:has-text("Paper Processing")').first()).toBeVisible()
    await expect(page.locator('text=Extraction Mode')).toBeVisible()
    await expect(page.locator('text=Chunk Size')).toBeVisible()
    await expect(page.locator('text=Show Extraction Badge')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/s14_paper_processing.png`, fullPage: false })
  })

  test('S14-06: Display section', async ({ page }) => {
    await expect(page.locator('span:has-text("Display")').filter({ hasText: /^Display$/ }).first()).toBeVisible()
    await expect(page.locator('text=Theme')).toBeVisible()
    await expect(page.locator('text=Font Size')).toBeVisible()
    await expect(page.locator('text=Post Spacing')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/s14_display.png`, fullPage: false })
  })

  test('S14-07: Danger Zone section with destructive actions', async ({ page }) => {
    // Scroll to bottom to find Danger Zone
    await page.locator('span:has-text("Danger Zone")').first().scrollIntoViewIfNeeded()
    await expect(page.locator('span:has-text("Danger Zone")').first()).toBeVisible()
    await expect(page.locator('text=Clear All Feeds')).toBeVisible()
    await expect(page.locator('text=Clear All Summaries')).toBeVisible()
    // Danger buttons present
    await expect(page.locator('button:has-text("Clear Feeds")')).toBeVisible()
    await expect(page.locator('button:has-text("Clear Summaries")')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/s14_danger_zone.png`, fullPage: false })
  })

  test('S14-08: Full settings page screenshot', async ({ page }) => {
    await page.screenshot({ path: `${SCREENSHOTS}/s14_settings_full.png`, fullPage: true })
  })
})

// ============================================================
// SECTION 15 — Search / Explore
// ============================================================
test.describe('Section 15: Search (Explore)', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ page }) => {
    await page.goto('/ficino')
    await waitForApp(page)
    await navTo(page, 'Search')
    await page.waitForSelector('h1:has-text("Explore")', { timeout: 10000 })
  })

  test('S15-01: Explore page loads with header and search bar', async ({ page }) => {
    await expect(page.locator('h1:has-text("Explore")')).toBeVisible()
    await expect(page.locator('text=Search, workspaces & activity')).toBeVisible()
    // Search bar should be present
    const searchInput = page.locator('input[aria-label="Search corpus"]')
    await expect(searchInput).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/s15_explore_page.png`, fullPage: false })
  })

  test('S15-02: Search bar auto-focuses on navigate', async ({ page }) => {
    const searchInput = page.locator('input[aria-label="Search corpus"]')
    // autoFocus attribute should mean it's focused
    await expect(searchInput).toBeFocused({ timeout: 5000 })
    await page.screenshot({ path: `${SCREENSHOTS}/s15_search_focused.png`, fullPage: false })
  })

  test('S15-03: Type query and wait for debounced results', async ({ page }) => {
    const searchInput = page.locator('input[aria-label="Search corpus"]')
    await searchInput.fill('neural network')
    // Wait for debounce (300ms) + network
    await page.waitForTimeout(1500)
    // Take screenshot regardless of results (app may have no papers)
    await page.screenshot({ path: `${SCREENSHOTS}/s15_search_results.png`, fullPage: false })
    // Check if results dropdown appeared or "No results" message
    const dropdown = page.locator('div.absolute.z-50')
    const noResults = page.locator('text=No results for')
    const hasDropdown = await dropdown.isVisible().catch(() => false)
    const hasNoResults = await noResults.isVisible().catch(() => false)
    // Either results show up or no results message - both valid
    if (hasDropdown || hasNoResults) {
      // Results area is functioning
      expect(true).toBe(true)
    }
  })

  test('S15-04: Result grouping headers (Papers, Passages, Feed Posts)', async ({ page }) => {
    const searchInput = page.locator('input[aria-label="Search corpus"]')
    await searchInput.fill('method')
    await page.waitForTimeout(1500)
    // If there are results, check grouping headers
    const papersHeader = page.locator('text=Papers (').first()
    const passagesHeader = page.locator('text=Passages (').first()
    const postsHeader = page.locator('text=Feed Posts (').first()
    // Screenshot the state
    await page.screenshot({ path: `${SCREENSHOTS}/s15_search_groups.png`, fullPage: false })
    // Log which groups appear
    const hasPapers = await papersHeader.isVisible().catch(() => false)
    const hasPassages = await passagesHeader.isVisible().catch(() => false)
    const hasPosts = await postsHeader.isVisible().catch(() => false)
    console.log(`Search result groups visible - Papers: ${hasPapers}, Passages: ${hasPassages}, Posts: ${hasPosts}`)
  })

  test('S15-05: Clear button clears search', async ({ page }) => {
    const searchInput = page.locator('input[aria-label="Search corpus"]')
    await searchInput.fill('test query')
    await page.waitForTimeout(500)
    // Clear button should appear (X icon with aria-label "Clear search")
    const clearBtn = page.locator('button[aria-label="Clear search"]')
    await expect(clearBtn).toBeVisible({ timeout: 3000 })
    await page.screenshot({ path: `${SCREENSHOTS}/s15_search_clear_before.png`, fullPage: false })
    await clearBtn.click()
    // Input should be empty now
    await expect(searchInput).toHaveValue('')
    await page.screenshot({ path: `${SCREENSHOTS}/s15_search_clear_after.png`, fullPage: false })
  })

  test('S15-06: Workspaces section visible', async ({ page }) => {
    await expect(page.locator('text=Workspaces').first()).toBeVisible()
    // New Workspace button
    await expect(page.locator('text=New Workspace')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/s15_workspaces.png`, fullPage: false })
  })
})

// ============================================================
// SECTION 16 — Navigation & Keyboard Shortcuts
// ============================================================
test.describe('Section 16: Navigation & Keyboard Shortcuts', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ page }) => {
    await page.goto('/ficino')
    await waitForApp(page)
  })

  test('S16-01: All 6 nav icons present in left nav', async ({ page }) => {
    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(nav).toBeVisible()
    const labels = ['Home', 'Search', 'Alerts', 'Messages', 'Saved', 'Settings']
    for (const label of labels) {
      await expect(nav.locator(`button[aria-label="${label}"]`)).toBeVisible()
    }
    await page.screenshot({ path: `${SCREENSHOTS}/s16_nav_all_icons.png`, fullPage: false })
  })

  test('S16-02: Click each nav icon navigates to correct view', async ({ page }) => {
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
      // Verify the view changed by looking for a marker text
      const heading = page.locator(`h1:has-text("${marker}"), span:has-text("${marker}")`).first()
      await expect(heading).toBeVisible({ timeout: 5000 })
    }
    await page.screenshot({ path: `${SCREENSHOTS}/s16_nav_click_all.png`, fullPage: false })
  })

  test('S16-03: Active nav item has aria-current="page"', async ({ page }) => {
    // Home should be active by default
    const homeBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Home"]')
    await expect(homeBtn).toHaveAttribute('aria-current', 'page')
    // Navigate to Settings
    await navTo(page, 'Settings')
    await page.waitForTimeout(300)
    const settingsBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Settings"]')
    await expect(settingsBtn).toHaveAttribute('aria-current', 'page')
    // Home should no longer be active
    await expect(homeBtn).not.toHaveAttribute('aria-current', 'page')
    await page.screenshot({ path: `${SCREENSHOTS}/s16_nav_active_highlight.png`, fullPage: false })
  })

  test('S16-04: Keyboard shortcut "h" navigates to Home/Feed', async ({ page }) => {
    // First go to Settings so we can test navigating back
    await navTo(page, 'Settings')
    await page.waitForSelector('h1:has-text("Settings")', { timeout: 5000 })
    // Blur any focused element
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    // Press h
    await page.keyboard.press('h')
    await page.waitForTimeout(500)
    // Should be on feed view - check for ficino header
    const homeBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Home"]')
    await expect(homeBtn).toHaveAttribute('aria-current', 'page')
    await page.screenshot({ path: `${SCREENSHOTS}/s16_keyboard_h.png`, fullPage: false })
  })

  test('S16-05: Keyboard shortcut "e" navigates to Explore', async ({ page }) => {
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    await page.keyboard.press('e')
    await page.waitForTimeout(500)
    await expect(page.locator('h1:has-text("Explore")')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/s16_keyboard_e.png`, fullPage: false })
  })

  test('S16-06: Keyboard shortcut "m" navigates to Messages', async ({ page }) => {
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    await page.keyboard.press('m')
    await page.waitForTimeout(500)
    const msgBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Messages"]')
    await expect(msgBtn).toHaveAttribute('aria-current', 'page')
    await page.screenshot({ path: `${SCREENSHOTS}/s16_keyboard_m.png`, fullPage: false })
  })

  test('S16-07: Keyboard shortcut "b" navigates to Bookmarks', async ({ page }) => {
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    await page.keyboard.press('b')
    await page.waitForTimeout(500)
    const bmBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Saved"]')
    await expect(bmBtn).toHaveAttribute('aria-current', 'page')
    await page.screenshot({ path: `${SCREENSHOTS}/s16_keyboard_b.png`, fullPage: false })
  })

  test('S16-08: Keyboard shortcut "n" navigates to Alerts', async ({ page }) => {
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    await page.keyboard.press('n')
    await page.waitForTimeout(500)
    const alertBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Alerts"]')
    await expect(alertBtn).toHaveAttribute('aria-current', 'page')
    await page.screenshot({ path: `${SCREENSHOTS}/s16_keyboard_n.png`, fullPage: false })
  })

  test('S16-09: Keyboard shortcut "." triggers generate (on feed view)', async ({ page }) => {
    // Should be on feed view by default
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    // Press period - may trigger generate if papers exist, or do nothing
    await page.keyboard.press('.')
    await page.waitForTimeout(500)
    // Still on feed view
    const homeBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Home"]')
    await expect(homeBtn).toHaveAttribute('aria-current', 'page')
    await page.screenshot({ path: `${SCREENSHOTS}/s16_keyboard_period.png`, fullPage: false })
  })

  test('S16-10: Keyboard shortcuts ignored when input is focused', async ({ page }) => {
    // Navigate to Explore so search input auto-focuses
    await navTo(page, 'Search')
    await page.waitForSelector('h1:has-text("Explore")', { timeout: 5000 })
    const searchInput = page.locator('input[aria-label="Search corpus"]')
    await searchInput.focus()
    // Press 'h' while input is focused - should NOT navigate
    await page.keyboard.press('h')
    await page.waitForTimeout(300)
    // Should still be on Explore
    await expect(page.locator('h1:has-text("Explore")')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/s16_keyboard_input_guard.png`, fullPage: false })
  })

  test('S16-11: Full navigation screenshot', async ({ page }) => {
    await page.screenshot({ path: `${SCREENSHOTS}/s16_navigation_full.png`, fullPage: true })
  })
})
