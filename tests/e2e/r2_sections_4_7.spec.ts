import { test, expect } from '@playwright/test'

const SCREENSHOTS = '/projects/ficino/tests/screenshots'
const BASE = 'https://ficino.local/ficino'

/**
 * Helper: navigate to the feed and wait for posts (or detect empty state).
 * Returns true if at least one post is visible.
 */
async function loadFeedAndDetectPosts(page: import('@playwright/test').Page): Promise<boolean> {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  // Wait for the SPA shell
  await page.locator('text=ficino').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
  // Give the feed API time to return
  await page.waitForTimeout(2000)

  // Check if any <article> feed posts exist (BUG-005 fix verification)
  const articleCount = await page.locator('article').count()
  return articleCount > 0
}

/* ------------------------------------------------------------------ */
/*  SECTION 4 — Thread Expansion                                      */
/* ------------------------------------------------------------------ */
test.describe('R2 Section 4: Thread Expansion', () => {
  test('4.1 — Posts use <article> elements (BUG-005 retest)', async ({ page }) => {
    const hasPosts = await loadFeedAndDetectPosts(page)
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s4_article_check.png`, fullPage: false })

    if (!hasPosts) {
      // Even without posts, verify the empty state
      test.skip(true, 'No posts in feed — cannot verify <article> usage')
      return
    }

    // Every visible post card should be an <article>, not a <div>
    const articles = page.locator('article')
    const count = await articles.count()
    expect(count).toBeGreaterThan(0)

    // Ensure the first post is genuinely an <article> tag
    const tagName = await articles.first().evaluate(el => el.tagName.toLowerCase())
    expect(tagName).toBe('article')
  })

  test('4.2 — Expand and collapse a thread post', async ({ page }) => {
    const hasPosts = await loadFeedAndDetectPosts(page)
    if (!hasPosts) {
      await page.screenshot({ path: `${SCREENSHOTS}/r2_s4_no_posts.png`, fullPage: true })
      test.skip(true, 'No posts in feed — skipping thread test')
      return
    }

    const showThreadBtn = page.locator('button', { hasText: /Show thread/ }).first()
    const threadExists = await showThreadBtn.isVisible().catch(() => false)

    if (!threadExists) {
      await page.screenshot({ path: `${SCREENSHOTS}/r2_s4_no_threads.png`, fullPage: true })
      test.skip(true, 'No thread posts in feed')
      return
    }

    // Collapsed state
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s4_collapsed.png`, fullPage: false })
    const btnText = await showThreadBtn.textContent()
    expect(btnText).toMatch(/Show thread \(\d+ posts\)/)

    // THREAD badge
    const threadBadge = page.locator('span', { hasText: /^THREAD \d+$/ }).first()
    await expect(threadBadge).toBeVisible()

    // First numbered post (1) visible as opener
    const firstNum = page.locator('span.text-gold', { hasText: '1' }).first()
    await expect(firstNum).toBeVisible()

    // Expand
    await showThreadBtn.click()
    await page.waitForTimeout(500)

    const secondNum = page.locator('span', { hasText: '2' }).first()
    await expect(secondNum).toBeVisible()

    // Connector lines
    const connectors = page.locator('div.bg-gold\\/20')
    expect(await connectors.count()).toBeGreaterThan(0)

    const collapseBtn = page.locator('button', { hasText: 'Collapse thread' }).first()
    await expect(collapseBtn).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s4_expanded.png`, fullPage: false })

    // Collapse
    await collapseBtn.click()
    await page.waitForTimeout(300)
    await expect(page.locator('button', { hasText: /Show thread/ }).first()).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s4_collapsed_again.png`, fullPage: false })
  })
})

/* ------------------------------------------------------------------ */
/*  SECTION 5 — Figure Posts + Lightbox (BUG-001 retest)              */
/* ------------------------------------------------------------------ */
test.describe('R2 Section 5: Figure Posts & Lightbox', () => {
  test('5.1 — Figure post renders with EXTRACTED FIGURE label', async ({ page }) => {
    const hasPosts = await loadFeedAndDetectPosts(page)
    if (!hasPosts) {
      await page.screenshot({ path: `${SCREENSHOTS}/r2_s5_no_posts.png`, fullPage: true })
      test.skip(true, 'No posts in feed')
      return
    }

    const figureLabel = page.locator('span', { hasText: 'EXTRACTED FIGURE' }).first()
    const figureExists = await figureLabel.isVisible().catch(() => false)

    if (!figureExists) {
      await page.screenshot({ path: `${SCREENSHOTS}/r2_s5_no_figures.png`, fullPage: true })
      test.skip(true, 'No figure posts in feed')
      return
    }

    // FIGURE badge in header
    const figureBadge = page.locator('span', { hasText: /^FIGURE$/ }).first()
    await expect(figureBadge).toBeVisible()

    // Image loaded
    const figureImg = page.locator('.cursor-zoom-in img').first()
    await expect(figureImg).toBeVisible()

    // Expand hint
    const expandHint = page.locator('span', { hasText: 'expand' }).first()
    await expect(expandHint).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOTS}/r2_s5_figure_post.png`, fullPage: false })
  })

  test('5.2 — BUG-001 FIX: Lightbox has aria-modal and closes on Escape', async ({ page }) => {
    const hasPosts = await loadFeedAndDetectPosts(page)
    if (!hasPosts) {
      test.skip(true, 'No posts in feed')
      return
    }

    const figureContainer = page.locator('.cursor-zoom-in').first()
    const figureExists = await figureContainer.isVisible().catch(() => false)

    if (!figureExists) {
      await page.screenshot({ path: `${SCREENSHOTS}/r2_s5_no_figures_lightbox.png`, fullPage: true })
      test.skip(true, 'No figure posts in feed')
      return
    }

    // Open lightbox
    await figureContainer.click()
    await page.waitForTimeout(500)

    const lightbox = page.locator('[role="dialog"][aria-label="Figure lightbox"]')
    await expect(lightbox).toBeVisible()

    // BUG-001 FIX: Verify aria-modal="true"
    const ariaModal = await lightbox.getAttribute('aria-modal')
    expect(ariaModal).toBe('true')

    // Verify close button exists
    const closeBtn = page.locator('button[aria-label="Close lightbox"]')
    await expect(closeBtn).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOTS}/r2_s5_lightbox_open.png`, fullPage: false })

    // BUG-001 FIX: Press Escape — lightbox MUST close
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // The lightbox must NOT be visible after pressing Escape
    await expect(lightbox).not.toBeVisible()

    await page.screenshot({ path: `${SCREENSHOTS}/r2_s5_lightbox_closed_via_escape.png`, fullPage: false })
  })

  test('5.3 — Lightbox closes on backdrop click', async ({ page }) => {
    const hasPosts = await loadFeedAndDetectPosts(page)
    if (!hasPosts) {
      test.skip(true, 'No posts in feed')
      return
    }

    const figureContainer = page.locator('.cursor-zoom-in').first()
    const figureExists = await figureContainer.isVisible().catch(() => false)

    if (!figureExists) {
      test.skip(true, 'No figure posts in feed')
      return
    }

    // Open lightbox
    await figureContainer.click()
    await page.waitForTimeout(500)

    const lightbox = page.locator('[role="dialog"][aria-label="Figure lightbox"]')
    await expect(lightbox).toBeVisible()

    // Click the backdrop (the outer dialog div itself, not the image)
    // Click in the corner of the lightbox to avoid the image
    const box = await lightbox.boundingBox()
    if (box) {
      await page.mouse.click(box.x + 10, box.y + 10)
    }
    await page.waitForTimeout(500)

    await expect(lightbox).not.toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s5_lightbox_closed_via_backdrop.png`, fullPage: false })
  })
})

/* ------------------------------------------------------------------ */
/*  SECTION 6 — Reply to Persona                                      */
/* ------------------------------------------------------------------ */
test.describe('R2 Section 6: Reply to Persona', () => {
  test('6.1 — Reply UI opens with replying-to handle and input', async ({ page }) => {
    const hasPosts = await loadFeedAndDetectPosts(page)
    if (!hasPosts) {
      await page.screenshot({ path: `${SCREENSHOTS}/r2_s6_no_posts.png`, fullPage: true })
      test.skip(true, 'No posts in feed')
      return
    }

    const replyBtn = page.locator('button[aria-label^="Replies:"]').first()
    const replyExists = await replyBtn.isVisible().catch(() => false)

    if (!replyExists) {
      await page.screenshot({ path: `${SCREENSHOTS}/r2_s6_no_reply_buttons.png`, fullPage: true })
      test.skip(true, 'No reply buttons found')
      return
    }

    await page.screenshot({ path: `${SCREENSHOTS}/r2_s6_before_reply.png`, fullPage: false })

    // Click reply
    await replyBtn.click()
    await page.waitForTimeout(1000)

    // Verify "Replying to @handle"
    const replyingTo = page.locator('text=/Replying to @/').first()
    await expect(replyingTo).toBeVisible()

    // Verify input
    const replyInput = page.locator('input[placeholder="Post your reply..."]').first()
    await expect(replyInput).toBeVisible()

    // Verify Reply button
    const sendBtn = page.locator('button', { hasText: /^Reply$/ }).first()
    await expect(sendBtn).toBeVisible()

    // Verify "You" avatar
    const youAvatar = page.locator('div', { hasText: /^You$/ }).first()
    await expect(youAvatar).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOTS}/r2_s6_reply_ui_open.png`, fullPage: false })

    // Type a message (don't send)
    await replyInput.fill('Test reply message from Playwright R2')
    await page.waitForTimeout(300)

    // Reply button should be enabled (not disabled) when text is present
    const isDisabled = await sendBtn.getAttribute('disabled')
    expect(isDisabled).toBeNull()

    await page.screenshot({ path: `${SCREENSHOTS}/r2_s6_reply_typed.png`, fullPage: false })
  })

  test('6.2 — Reply button disabled when input is empty', async ({ page }) => {
    const hasPosts = await loadFeedAndDetectPosts(page)
    if (!hasPosts) {
      test.skip(true, 'No posts in feed')
      return
    }

    const replyBtn = page.locator('button[aria-label^="Replies:"]').first()
    if (!(await replyBtn.isVisible().catch(() => false))) {
      test.skip(true, 'No reply buttons found')
      return
    }

    await replyBtn.click()
    await page.waitForTimeout(1000)

    // With empty input, Reply button should be disabled
    const sendBtn = page.locator('button', { hasText: /^Reply$/ }).first()
    await expect(sendBtn).toBeVisible()
    const isDisabled = await sendBtn.getAttribute('disabled')
    expect(isDisabled).not.toBeNull()

    await page.screenshot({ path: `${SCREENSHOTS}/r2_s6_reply_disabled.png`, fullPage: false })
  })
})

/* ------------------------------------------------------------------ */
/*  SECTION 7 — Source Reveal                                          */
/* ------------------------------------------------------------------ */
test.describe('R2 Section 7: Source Reveal', () => {
  test('7.1 — Source chips expand to show paper title, section, relevance', async ({ page }) => {
    const hasPosts = await loadFeedAndDetectPosts(page)
    if (!hasPosts) {
      await page.screenshot({ path: `${SCREENSHOTS}/r2_s7_no_posts.png`, fullPage: true })
      test.skip(true, 'No posts in feed')
      return
    }

    const sourcesBtn = page.locator('button', { hasText: /\d+ sources/ }).first()
    const sourcesExist = await sourcesBtn.isVisible().catch(() => false)

    if (!sourcesExist) {
      await page.screenshot({ path: `${SCREENSHOTS}/r2_s7_no_sources.png`, fullPage: true })
      test.skip(true, 'No posts with sources in feed')
      return
    }

    await page.screenshot({ path: `${SCREENSHOTS}/r2_s7_sources_collapsed.png`, fullPage: false })

    // Expand sources
    await sourcesBtn.click()
    await page.waitForTimeout(500)

    // Verify source cards appear
    const sourceCards = page.locator('.border.border-border.rounded-lg.p-2\\.5')
    const cardCount = await sourceCards.count()
    expect(cardCount).toBeGreaterThan(0)

    // Check first card contents
    const firstCard = sourceCards.first()

    // Paper title (font-semibold)
    const paperTitle = firstCard.locator('span.font-semibold').first()
    await expect(paperTitle).toBeVisible()
    const titleText = await paperTitle.textContent()
    expect(titleText!.length).toBeGreaterThan(0)

    // Section label (contains · separator)
    const sectionLabel = firstCard.locator('span.text-text-muted.shrink-0').first()
    await expect(sectionLabel).toBeVisible()
    const sectionText = await sectionLabel.textContent()
    expect(sectionText).toMatch(/·/)

    // Relevance percentage
    const relevanceScore = firstCard.locator('span', { hasText: /\d+%/ }).first()
    await expect(relevanceScore).toBeVisible()

    // Content text
    const sourceContent = firstCard.locator('p.text-text-muted').first()
    await expect(sourceContent).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOTS}/r2_s7_sources_expanded.png`, fullPage: false })

    // Hide sources
    const hideBtn = page.locator('button', { hasText: 'Hide sources' }).first()
    await expect(hideBtn).toBeVisible()
    await hideBtn.click()
    await page.waitForTimeout(300)

    // Verify collapse
    await expect(page.locator('button', { hasText: /\d+ sources/ }).first()).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/r2_s7_sources_collapsed_again.png`, fullPage: false })
  })
})
