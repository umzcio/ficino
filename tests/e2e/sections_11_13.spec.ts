import { test, expect, type Page } from '@playwright/test'

const SCREENSHOT_DIR = '/projects/ficino/tests/screenshots'
const APP_URL = 'https://ficino.local/ficino'

/**
 * Helper: navigate to the Ficino app and wait for the shell to render.
 * Uses the full URL because baseURL + goto('/') resolves to the portal root.
 */
async function waitForApp(page: Page) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForSelector('nav[aria-label="Main navigation"]', { timeout: 20_000 })
}

// ---------------------------------------------------------------------------
// SECTION 11 — Workspaces
// ---------------------------------------------------------------------------
test.describe('Section 11: Workspaces', () => {
  test('11.1 — Explore page loads and shows Default workspace', async ({ page }) => {
    await waitForApp(page)

    // Click Search/Explore nav button
    const exploreBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Search"]')
    await expect(exploreBtn).toBeVisible()
    await exploreBtn.click()

    // Expect the Explore header
    const header = page.locator('h1', { hasText: 'Explore' })
    await expect(header).toBeVisible({ timeout: 10_000 })

    // Check for "Workspaces" section label
    const wsLabel = page.locator('text=Workspaces').first()
    await expect(wsLabel).toBeVisible()

    // Look for "Default" workspace in the list
    const defaultWs = page.locator('text=Default').first()
    await expect(defaultWs).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s11_explore_default_workspace.png`, fullPage: true })
  })

  test('11.2 — New Workspace creation flow', async ({ page }) => {
    await waitForApp(page)

    // Navigate to Explore
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Search"]').click()
    await page.locator('h1', { hasText: 'Explore' }).waitFor({ state: 'visible', timeout: 10_000 })

    // Click "New Workspace" button (dashed border button with Plus icon)
    const newWsBtn = page.locator('button', { hasText: 'New Workspace' })
    await expect(newWsBtn).toBeVisible()
    await newWsBtn.click()

    // The input should appear with placeholder "Workspace name..."
    const nameInput = page.locator('input[placeholder="Workspace name..."]')
    await expect(nameInput).toBeVisible()

    // Type a test workspace name
    const testName = `TestWS-${Date.now()}`
    await nameInput.fill(testName)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s11_workspace_create_form.png` })

    // Click the "Create" button
    const createBtn = page.locator('button', { hasText: 'Create' })
    await createBtn.click()

    // Wait for workspace to appear in list
    await page.waitForTimeout(2000)

    // Verify new workspace appears
    const newWs = page.locator(`text=${testName}`)
    await expect(newWs).toBeVisible({ timeout: 10_000 })

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s11_workspace_created.png`, fullPage: true })

    // Clean up: delete the test workspace by hovering to reveal delete button
    const wsCard = page.locator('button', { hasText: testName })
    await wsCard.hover()
    // The delete button is inside the ws card, only visible on hover for non-active, non-Default workspaces
    const deleteBtn = wsCard.locator('button').last()
    if (await deleteBtn.isVisible().catch(() => false)) {
      await deleteBtn.click()
      await page.waitForTimeout(1000)
    }
  })

  test('11.3 — Workspace dropdown in feed header', async ({ page }) => {
    await waitForApp(page)

    // The WorkspaceDropdown only shows when there are 2+ workspaces
    // Look for the folder icon button in the header area
    const headerDropdown = page.locator('.relative button', { hasText: /Default|Workspace/ }).first()
    const dropdownVisible = await headerDropdown.isVisible().catch(() => false)

    if (dropdownVisible) {
      await headerDropdown.click()
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${SCREENSHOT_DIR}/s11_workspace_dropdown_open.png` })
    } else {
      // Only one workspace exists, dropdown is hidden by design (expected)
      await page.screenshot({ path: `${SCREENSHOT_DIR}/s11_workspace_dropdown_single_ws.png` })
    }
  })
})

// ---------------------------------------------------------------------------
// SECTION 12 — Tags
// ---------------------------------------------------------------------------
test.describe('Section 12: Tags', () => {
  test('12.1 — Corpus panel shows papers with tag buttons', async ({ page }) => {
    await waitForApp(page)

    // Wait for corpus data to load
    await page.waitForTimeout(3000)

    // The corpus panel is in the sidebar (desktop only, lg breakpoint, viewport is 1280)
    const corpusHeading = page.locator('text=Active Corpus')
    const corpusVisible = await corpusHeading.isVisible().catch(() => false)

    if (corpusVisible) {
      await expect(corpusHeading).toBeVisible()

      // Look for the "+ #" add-tag button on papers
      // The button contains a Plus icon and "#" text
      const addTagBtn = page.locator('button:has-text("#")').first()
      const tagBtnVisible = await addTagBtn.isVisible().catch(() => false)

      if (tagBtnVisible) {
        await page.screenshot({ path: `${SCREENSHOT_DIR}/s12_corpus_with_tag_buttons.png`, fullPage: true })

        // Click the "+ #" button to open tag input
        await addTagBtn.click()

        // Look for the tag name input
        const tagInput = page.locator('input[placeholder="tag name"]')
        await expect(tagInput).toBeVisible({ timeout: 5_000 })

        await page.screenshot({ path: `${SCREENSHOT_DIR}/s12_tag_input_open.png` })

        // Type a test tag and submit
        const testTag = `test${Date.now()}`
        await tagInput.fill(testTag)
        await tagInput.press('Enter')

        // Wait for tag to be applied
        await page.waitForTimeout(2000)

        await page.screenshot({ path: `${SCREENSHOT_DIR}/s12_tag_added.png`, fullPage: true })

        // Check if the tag badge appeared
        const tagBadge = page.locator(`text=#${testTag}`).first()
        const badgeAppeared = await tagBadge.isVisible().catch(() => false)

        if (badgeAppeared) {
          // Check for tag filter bar ("All" button appears when tags exist)
          const allFilterBtn = page.locator('button', { hasText: 'All' }).first()
          const filterBarExists = await allFilterBtn.isVisible().catch(() => false)

          if (filterBarExists) {
            await page.screenshot({ path: `${SCREENSHOT_DIR}/s12_tag_filter_bar.png` })
          }

          // Clean up: remove the test tag
          const removeTagBtn = page.locator(`button[aria-label="Remove tag ${testTag}"]`)
          if (await removeTagBtn.isVisible().catch(() => false)) {
            await removeTagBtn.click()
            await page.waitForTimeout(1000)
          }
        }
      } else {
        // No papers in corpus, screenshot the empty state
        await page.screenshot({ path: `${SCREENSHOT_DIR}/s12_corpus_empty.png`, fullPage: true })
      }
    } else {
      // Sidebar not visible at this viewport width
      await page.screenshot({ path: `${SCREENSHOT_DIR}/s12_corpus_panel_not_visible.png`, fullPage: true })
    }
  })

  test('12.2 — Tag filter bar filters papers', async ({ page }) => {
    await waitForApp(page)
    await page.waitForTimeout(3000)

    // Check if tag filter bar is present (requires existing tags on papers)
    // The "All" button in the tag filter bar is inside the corpus panel
    const allBtn = page.locator('button:has-text("All")').first()
    const filterBarVisible = await allBtn.isVisible().catch(() => false)

    if (filterBarVisible) {
      const tagFilters = page.locator('button').filter({ hasText: /^#/ })
      const tagCount = await tagFilters.count()

      if (tagCount > 0) {
        await tagFilters.first().click()
        await page.waitForTimeout(500)
        await page.screenshot({ path: `${SCREENSHOT_DIR}/s12_tag_filter_active.png`, fullPage: true })

        // Reset filter
        await allBtn.click()
        await page.waitForTimeout(500)
      }
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s12_tags_final_state.png`, fullPage: true })
  })
})

// ---------------------------------------------------------------------------
// SECTION 13 — Alerts
// ---------------------------------------------------------------------------
test.describe('Section 13: Alerts', () => {
  test('13.1 — Alerts view loads from bell icon', async ({ page }) => {
    await waitForApp(page)

    // Click the Bell icon in the left nav
    const bellBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Alerts"]')
    await expect(bellBtn).toBeVisible()

    // Check for unread badge count before clicking
    const badge = bellBtn.locator('span').filter({ hasText: /\d+/ })
    const hasBadge = await badge.isVisible().catch(() => false)

    await bellBtn.click()

    // Expect "Alerts" heading
    const alertsHeader = page.locator('h1', { hasText: 'Alerts' })
    await expect(alertsHeader).toBeVisible({ timeout: 10_000 })

    // Check the subtitle
    const subtitle = page.locator('text=Learning insights from your corpus')
    await expect(subtitle).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s13_alerts_view_loaded.png`, fullPage: true })
  })

  test('13.2 — Alert cards with colors and icons', async ({ page }) => {
    await waitForApp(page)

    // Navigate to Alerts
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Alerts"]').click()
    await page.locator('h1', { hasText: 'Alerts' }).waitFor({ state: 'visible', timeout: 10_000 })

    // Wait for loading spinner to finish
    await page.waitForTimeout(3000)

    // Check if there are alert cards or empty state
    const emptyState = page.locator('text=No alerts yet')
    const isEmpty = await emptyState.isVisible().catch(() => false)

    if (isEmpty) {
      const emptyDetail = page.locator('text=Upload papers and generate feeds')
      await expect(emptyDetail).toBeVisible()
      await page.screenshot({ path: `${SCREENSHOT_DIR}/s13_alerts_empty_state.png`, fullPage: true })
    } else {
      // Alert cards exist - check for known type labels
      const alertLabels = ['Contradiction', 'Debate Spike', 'Go Deeper', 'Stale Paper', 'Emerging Theme']
      const foundLabels: string[] = []

      for (const label of alertLabels) {
        const el = page.locator(`text=${label}`).first()
        if (await el.isVisible().catch(() => false)) {
          foundLabels.push(label)
        }
      }

      // Check for dismiss buttons
      const dismissBtns = page.locator('button[aria-label^="Dismiss"]')
      const dismissCount = await dismissBtns.count()

      await page.screenshot({ path: `${SCREENSHOT_DIR}/s13_alert_cards.png`, fullPage: true })
    }
  })

  test('13.3 — Mark all read button', async ({ page }) => {
    await waitForApp(page)

    // Navigate to Alerts
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Alerts"]').click()
    await page.locator('h1', { hasText: 'Alerts' }).waitFor({ state: 'visible', timeout: 10_000 })

    await page.waitForTimeout(3000)

    // Look for "Mark all read" button (only visible when there are unread alerts)
    const markAllBtn = page.locator('button', { hasText: 'Mark all read' })
    const markAllVisible = await markAllBtn.isVisible().catch(() => false)

    if (markAllVisible) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/s13_mark_all_read_button.png` })

      await markAllBtn.click()
      await page.waitForTimeout(1000)

      // After clicking, the button should disappear (no more unread)
      await page.screenshot({ path: `${SCREENSHOT_DIR}/s13_after_mark_all_read.png`, fullPage: true })
    } else {
      // No unread alerts, so button is not shown
      await page.screenshot({ path: `${SCREENSHOT_DIR}/s13_no_unread_alerts.png`, fullPage: true })
    }
  })

  test('13.4 — Alert badge count in nav', async ({ page }) => {
    await waitForApp(page)

    // Check the bell button for a count badge
    const bellBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Alerts"]')
    await expect(bellBtn).toBeVisible()

    // The badge is a span inside the button showing a number
    const badge = bellBtn.locator('span').filter({ hasText: /^\d+\+?$/ })
    const hasBadge = await badge.isVisible().catch(() => false)

    if (hasBadge) {
      const badgeText = await badge.textContent()
      expect(badgeText).toBeTruthy()
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s13_alert_nav_badge.png` })
  })
})
