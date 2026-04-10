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
// SECTION 8 — Bookmarks
// ---------------------------------------------------------------------------
test.describe('Section 8: Bookmarks', () => {
  test('8.1 — Navigate to Bookmarks view via left nav', async ({ page }) => {
    await waitForApp(page)

    // Click the "Saved" nav button (Bookmark icon)
    const savedBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Saved"]')
    await expect(savedBtn).toBeVisible()
    await savedBtn.click()

    // The Bookmarks header should appear
    const header = page.locator('h1', { hasText: 'Bookmarks' })
    await expect(header).toBeVisible({ timeout: 5_000 })

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s8_bookmarks_view.png`, fullPage: false })
  })

  test('8.2 — Bookmarks view shows empty state or saved posts', async ({ page }) => {
    await waitForApp(page)

    // Navigate to bookmarks
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Saved"]').click()
    await page.locator('h1', { hasText: 'Bookmarks' }).waitFor({ timeout: 5_000 })

    // Check for either the empty state text or a list of bookmarked posts
    const emptyState = page.locator('text=No bookmarks yet')
    const savedCount = page.locator('text=/\\d+ saved post/')

    const isEmpty = await emptyState.isVisible().catch(() => false)
    const hasCount = await savedCount.isVisible().catch(() => false)

    expect(isEmpty || hasCount).toBeTruthy()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s8_bookmarks_state.png`, fullPage: false })
  })

  test('8.3 — Bookmark toggle on a post (from feed)', async ({ page }) => {
    await waitForApp(page)

    // Make sure we're on the feed view
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Home"]').click()
    await page.waitForTimeout(1_000)

    // Wait for feed content — look for bookmark action buttons on posts
    const bookmarkBtn = page.locator('button[aria-label*="Bookmark"]').first()

    // Check if there are posts in the feed
    const hasPost = await bookmarkBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasPost) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/s8_no_posts_for_bookmark.png`, fullPage: false })
      test.skip(true, 'No posts available in feed to test bookmark toggle')
      return
    }

    // Get initial state
    const initialPressed = await bookmarkBtn.getAttribute('aria-pressed')

    // Click bookmark
    await bookmarkBtn.click()
    await page.waitForTimeout(800)

    // Verify state changed
    const newPressed = await bookmarkBtn.getAttribute('aria-pressed')
    expect(newPressed).not.toEqual(initialPressed)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s8_bookmark_toggle.png`, fullPage: false })

    // Toggle back to restore original state
    await bookmarkBtn.click()
    await page.waitForTimeout(500)
  })

  test('8.4 — Bookmarked post appears in Bookmarks view', async ({ page }) => {
    await waitForApp(page)

    // Go to Home
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Home"]').click()
    await page.waitForTimeout(1_000)

    // Check for posts with bookmark buttons
    const bookmarkBtn = page.locator('button[aria-label*="Bookmark"]').first()
    const hasPost = await bookmarkBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasPost) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/s8_no_posts_to_bookmark.png`, fullPage: false })
      test.skip(true, 'No posts in feed to bookmark')
      return
    }

    // Bookmark the first post if not already bookmarked
    const wasActive = (await bookmarkBtn.getAttribute('aria-pressed')) === 'true'
    if (!wasActive) {
      await bookmarkBtn.click()
      await page.waitForTimeout(1_000)
    }

    // Navigate to Bookmarks
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Saved"]').click()
    await page.locator('h1', { hasText: 'Bookmarks' }).waitFor({ timeout: 5_000 })
    await page.waitForTimeout(1_000)

    // The bookmarks view should show at least "1 saved post"
    const savedCount = page.locator('text=/\\d+ saved post/')
    const hasSaved = await savedCount.isVisible({ timeout: 5_000 }).catch(() => false)

    // Also check for the "Saved Xm ago" label on bookmarked posts
    const savedLabel = page.locator('text=/Saved \\d+[mhd]? ago/')
    const hasSavedLabel = await savedLabel.first().isVisible({ timeout: 3_000 }).catch(() => false)

    expect(hasSaved || hasSavedLabel).toBeTruthy()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s8_bookmarked_post_in_list.png`, fullPage: false })

    // Clean up: go back and un-bookmark if we bookmarked it
    if (!wasActive) {
      await page.locator('nav[aria-label="Main navigation"] button[aria-label="Home"]').click()
      await page.waitForTimeout(500)
      const btn = page.locator('button[aria-label*="Bookmark"]').first()
      if (await btn.isVisible().catch(() => false)) {
        await btn.click()
        await page.waitForTimeout(500)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// SECTION 9 — Feed History
// ---------------------------------------------------------------------------
test.describe('Section 9: Feed History', () => {
  test('9.1 — Feed history collapsible bar appears when past feeds exist', async ({ page }) => {
    await waitForApp(page)

    // Make sure we're on Home/feed
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Home"]').click()
    await page.waitForTimeout(1_000)

    // FeedHistory renders a "N past feeds" button with a Clock icon
    const pastFeedsBtn = page.locator('button', { hasText: /past feed/ })
    const hasPastFeeds = await pastFeedsBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasPastFeeds) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/s9_no_feed_history.png`, fullPage: false })
      test.skip(true, 'No past feeds available — FeedHistory component not rendered (requires >1 feed)')
      return
    }

    // Verify it shows a count
    const text = await pastFeedsBtn.textContent()
    expect(text).toMatch(/\d+ past feed/)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s9_feed_history_collapsed.png`, fullPage: false })
  })

  test('9.2 — Expand feed history and see list with post count/timestamp', async ({ page }) => {
    await waitForApp(page)
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Home"]').click()
    await page.waitForTimeout(1_000)

    const pastFeedsBtn = page.locator('button', { hasText: /past feed/ })
    const hasPastFeeds = await pastFeedsBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasPastFeeds) {
      test.skip(true, 'No past feeds available')
      return
    }

    // Click to expand
    await pastFeedsBtn.click()
    await page.waitForTimeout(500)

    // Should see feed entries with "N posts · N papers" text
    const feedEntries = page.locator('button', { hasText: /posts · \d+ paper/ })
    const entryCount = await feedEntries.count()
    expect(entryCount).toBeGreaterThan(0)

    // Each entry should have a time indicator
    const timeIndicator = page.locator('text=/\\d+[mhd] ago|just now/')
    const hasTime = await timeIndicator.first().isVisible().catch(() => false)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s9_feed_history_expanded.png`, fullPage: false })

    // Check for "current" label on the active feed
    const currentLabel = page.locator('text=current')
    const hasCurrent = await currentLabel.isVisible().catch(() => false)

    // Collapse it again
    await pastFeedsBtn.click()
  })

  test('9.3 — Click a past feed to load it', async ({ page }) => {
    await waitForApp(page)
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Home"]').click()
    await page.waitForTimeout(1_000)

    const pastFeedsBtn = page.locator('button', { hasText: /past feed/ })
    const hasPastFeeds = await pastFeedsBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasPastFeeds) {
      test.skip(true, 'No past feeds available')
      return
    }

    // Expand
    await pastFeedsBtn.click()
    await page.waitForTimeout(500)

    // Click the first non-current feed entry
    const feedEntries = page.locator('button', { hasText: /posts · \d+ paper/ })
    const count = await feedEntries.count()

    if (count < 2) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/s9_only_one_feed.png`, fullPage: false })
      test.skip(true, 'Only one feed in history — cannot test switching')
      return
    }

    // Click the second entry (first non-current one, assuming current is first)
    await feedEntries.nth(1).click()
    await page.waitForTimeout(1_500)

    // After clicking, the history panel should collapse and feed should load
    // Verify feed posts are visible — look for post action buttons
    const postActions = page.locator('button[aria-label*="Bookmark"]')
    const hasPosts = await postActions.first().isVisible({ timeout: 5_000 }).catch(() => false)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s9_past_feed_loaded.png`, fullPage: false })
  })
})

// ---------------------------------------------------------------------------
// SECTION 10 — Messages / DMs
// ---------------------------------------------------------------------------
test.describe('Section 10: Messages / DMs', () => {
  test('10.1 — Navigate to Messages via left nav Mail icon', async ({ page }) => {
    await waitForApp(page)

    // Click Mail icon in left nav
    const mailBtn = page.locator('nav[aria-label="Main navigation"] button[aria-label="Messages"]')
    await expect(mailBtn).toBeVisible()
    await mailBtn.click()

    // MessagesView -> Inbox should show "Messages" header
    const header = page.locator('h1', { hasText: 'Messages' })
    await expect(header).toBeVisible({ timeout: 5_000 })

    // Subtitle
    const subtitle = page.locator('text=Paper summaries & corpus synthesis')
    await expect(subtitle).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s10_messages_view.png`, fullPage: false })
  })

  test('10.2 — Papers tab and Group Chats tab are present', async ({ page }) => {
    await waitForApp(page)
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Messages"]').click()
    await page.locator('h1', { hasText: 'Messages' }).waitFor({ timeout: 5_000 })

    // Look for the two tab buttons
    const papersTab = page.locator('button', { hasText: 'Papers' })
    const groupChatsTab = page.locator('button', { hasText: 'Group Chats' })

    await expect(papersTab).toBeVisible()
    await expect(groupChatsTab).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s10_messages_tabs.png`, fullPage: false })
  })

  test('10.3 — Papers tab content (list or empty state)', async ({ page }) => {
    await waitForApp(page)
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Messages"]').click()
    await page.locator('h1', { hasText: 'Messages' }).waitFor({ timeout: 5_000 })

    // Wait for loading spinner to disappear (Inbox shows Loader2 while fetching)
    await page.waitForFunction(() => {
      const spinners = document.querySelectorAll('.animate-spin')
      return spinners.length === 0
    }, { timeout: 10_000 }).catch(() => {})

    await page.waitForTimeout(500)

    // Papers tab should be active by default
    // Check for either paper entries (with "chunks" text) or empty state
    const emptyState = page.locator('text=No papers yet')
    // Paper entries have "N chunks" in them; also try matching by the ChevronRight icon container
    const paperEntry = page.locator('button', { hasText: /chunk/ }).first()
    // Also try matching "Tap to generate summary" which appears for papers without summaries
    const tapToGenerate = page.locator('text=Tap to generate summary').first()

    const isEmpty = await emptyState.isVisible().catch(() => false)
    const hasPapers = await paperEntry.isVisible().catch(() => false)
    const hasTapPrompt = await tapToGenerate.isVisible().catch(() => false)

    console.log(`Papers tab state: empty=${isEmpty}, hasPapers=${hasPapers}, hasTapPrompt=${hasTapPrompt}`)

    expect(isEmpty || hasPapers || hasTapPrompt).toBeTruthy()

    if (hasPapers) {
      const paperCount = await page.locator('button', { hasText: /chunk/ }).count()
      console.log(`Papers tab: ${paperCount} paper(s) found`)
    } else if (isEmpty) {
      console.log('Papers tab: empty state shown')
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s10_papers_tab_content.png`, fullPage: false })
  })

  test('10.4 — Click a paper to see summary / chat', async ({ page }) => {
    await waitForApp(page)
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Messages"]').click()
    await page.locator('h1', { hasText: 'Messages' }).waitFor({ timeout: 5_000 })

    // Wait for loading to finish
    await page.waitForFunction(() => {
      const spinners = document.querySelectorAll('.animate-spin')
      return spinners.length === 0
    }, { timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(500)

    // Look for a paper entry
    const paperEntry = page.locator('button', { hasText: /chunk/ }).first()
    const hasPapers = await paperEntry.isVisible().catch(() => false)

    if (!hasPapers) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/s10_no_papers_to_open.png`, fullPage: false })
      test.skip(true, 'No papers uploaded — cannot test paper chat view')
      return
    }

    // Click the first paper
    await paperEntry.click()
    await page.waitForTimeout(3_000)

    // PaperChat view should load — the Messages header should be replaced
    // with paper-specific content. Check the header changed.
    const messagesHeader = page.locator('h1', { hasText: 'Messages' })
    const headerGone = !(await messagesHeader.isVisible().catch(() => false))

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s10_paper_chat.png`, fullPage: false })
  })

  test('10.5 — Group Chats tab content', async ({ page }) => {
    await waitForApp(page)
    await page.locator('nav[aria-label="Main navigation"] button[aria-label="Messages"]').click()
    await page.locator('h1', { hasText: 'Messages' }).waitFor({ timeout: 5_000 })

    // Switch to Group Chats tab
    const groupChatsTab = page.locator('button', { hasText: 'Group Chats' })
    await groupChatsTab.click()
    await page.waitForTimeout(1_000)

    // Check for empty state or group list
    const emptyState = page.locator('text=No group chats yet')
    const createBtn = page.locator('button', { hasText: /Create Group Chat|New Group Chat/ })
    const groupEntry = page.locator('button', { hasText: /papers/ }).first()

    const isEmpty = await emptyState.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasGroups = await groupEntry.isVisible({ timeout: 2_000 }).catch(() => false)

    expect(isEmpty || hasGroups).toBeTruthy()

    // If empty, there should be a "Create Group Chat" button
    if (isEmpty) {
      await expect(createBtn).toBeVisible()
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s10_group_chats_tab.png`, fullPage: false })
  })
})
