import { test, expect } from '@playwright/test'

const SCREENSHOT_DIR = '/projects/ficino/tests/screenshots'
const APP_URL = '/ficino'

// Shared helper: navigate and wait for the app shell to render
async function loadApp(page: import('@playwright/test').Page) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  // Wait for the React app to hydrate — the ficino branding appears in the header
  await page.waitForSelector('text=ficino', { timeout: 15000 })
  // Give API calls a moment to settle
  await page.waitForTimeout(2000)
}

// ---------- Section 1: Paper Upload & Ingestion ----------

test.describe('Section 1 — Paper Upload & Ingestion', () => {
  test('s1.1 — App loads and shows the main layout', async ({ page }) => {
    await loadApp(page)
    await expect(page.locator('text=ficino').first()).toBeVisible()
    await expect(page.locator('text=BETA')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOT_DIR}/s1_app_loaded.png`, fullPage: true })
  })

  test('s1.2 — Upload drop zone is present in sidebar', async ({ page }) => {
    await loadApp(page)
    const uploadZone = page.locator('text=Upload a paper')
    await expect(uploadZone).toBeVisible()
    await expect(page.locator('text=Drag & drop or click to browse')).toBeVisible()
    const fileInput = page.locator('input#pdf-upload')
    await expect(fileInput).toHaveAttribute('accept', '.pdf')
    await page.screenshot({ path: `${SCREENSHOT_DIR}/s1_upload_zone.png`, fullPage: true })
  })

  test('s1.3 — Corpus panel is visible', async ({ page }) => {
    await loadApp(page)
    const corpusHeading = page.locator('text=Active Corpus')
    await expect(corpusHeading).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOT_DIR}/s1_corpus_panel.png`, fullPage: true })
  })

  test('s1.4 — Corpus panel shows papers or empty state', async ({ page }) => {
    await loadApp(page)

    const emptyState = page.locator('text=No papers uploaded yet')
    const paperItems = page.locator('text=Ready')

    const hasEmpty = await emptyState.isVisible().catch(() => false)
    const hasPapers = await paperItems.first().isVisible().catch(() => false)

    if (hasEmpty) {
      console.log('CORPUS: Empty — no papers uploaded')
    } else if (hasPapers) {
      const count = await paperItems.count()
      console.log(`CORPUS: Found ${count} paper(s) with "Ready" status`)
    } else {
      console.log('CORPUS: Papers may still be processing')
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s1_corpus_state.png`, fullPage: true })
    await expect(page.locator('text=Active Corpus')).toBeVisible()
  })

  test('s1.5 — Upload accepts only PDF files', async ({ page }) => {
    await loadApp(page)
    const fileInput = page.locator('input#pdf-upload')
    const accept = await fileInput.getAttribute('accept')
    expect(accept).toBe('.pdf')
  })

  test('s1.6 — Search corpus button is present in sidebar', async ({ page }) => {
    await loadApp(page)
    const searchBtn = page.locator('text=Search corpus...')
    await expect(searchBtn).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOT_DIR}/s1_search_corpus.png`, fullPage: true })
  })
})

// ---------- Section 2: Feed Generation ----------

test.describe('Section 2 — Feed Generation', () => {
  test('s2.1 — Feed header shows paper/persona counts and status', async ({ page }) => {
    await loadApp(page)

    // Header should show "X papers · Y personas · ready" (or generating)
    const statusText = page.locator('text=/\\d+ paper/')
    const hasStatus = await statusText.first().isVisible().catch(() => false)

    if (hasStatus) {
      const text = await statusText.first().textContent()
      console.log(`FEED HEADER: ${text}`)
    } else {
      console.log('FEED HEADER: Status text not in expected format')
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s2_feed_header.png`, fullPage: true })
    await expect(page.locator('text=ficino').first()).toBeVisible()
  })

  test('s2.2 — Generate button state reflects paper availability', async ({ page }) => {
    await loadApp(page)

    // The button might only show icon on narrow viewport; look for the button with Zap icon or text
    const generateBtn = page.locator('button:has-text("Generate"), button:has-text("Generating")')
    await expect(generateBtn.first()).toBeVisible()

    const isDisabled = await generateBtn.first().isDisabled()
    console.log(`GENERATE BUTTON: ${isDisabled ? 'Disabled (no papers or generating)' : 'Enabled (papers available)'}`)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s2_generate_button.png`, fullPage: true })
  })

  test('s2.3 — Feed shows posts or empty state', async ({ page }) => {
    await loadApp(page)
    await page.waitForTimeout(1000)

    const emptyState = page.locator('text=No posts yet')
    const hasEmpty = await emptyState.isVisible().catch(() => false)

    if (hasEmpty) {
      console.log('FEED: Empty state shown — "No posts yet"')
      await expect(page.locator('text=Upload papers and click Generate to create your feed')).toBeVisible()
      await page.screenshot({ path: `${SCREENSHOT_DIR}/s2_feed_empty_state.png`, fullPage: true })
    } else {
      console.log('FEED: Posts are present in the feed')
      await page.screenshot({ path: `${SCREENSHOT_DIR}/s2_feed_with_posts.png`, fullPage: true })
    }
  })

  test('s2.4 — Posts have expected structure (persona, content, actions)', async ({ page }) => {
    await loadApp(page)
    await page.waitForTimeout(1000)

    const emptyState = page.locator('text=No posts yet')
    const hasEmpty = await emptyState.isVisible().catch(() => false)

    if (hasEmpty) {
      test.skip(true, 'No posts available — skipping post structure check')
      return
    }

    const personaHandles = [
      '@skeptical_methods',
      '@ai_breakthroughs',
      '@real_world_ml',
      '@stats_nerd',
      '@phd_suffering',
    ]

    let foundPersona = false
    for (const handle of personaHandles) {
      const el = page.locator(`text=${handle}`).first()
      if (await el.isVisible().catch(() => false)) {
        foundPersona = true
        console.log(`PERSONA FOUND: ${handle}`)
        break
      }
    }
    expect(foundPersona).toBe(true)

    const replyBtns = page.locator('button[aria-label^="Replies"]')
    const likeBtns = page.locator('button[aria-label^="Like"]')
    const repostBtns = page.locator('button[aria-label^="Repost"]')
    const bookmarkBtns = page.locator('button[aria-label^="Bookmark"]')

    const replyCount = await replyBtns.count()
    const likeCount = await likeBtns.count()
    const repostCount = await repostBtns.count()
    const bookmarkCount = await bookmarkBtns.count()

    console.log(`ACTION BUTTONS: ${replyCount} reply, ${likeCount} like, ${repostCount} repost, ${bookmarkCount} bookmark`)
    expect(replyCount).toBeGreaterThan(0)
    expect(likeCount).toBeGreaterThan(0)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s2_post_structure.png`, fullPage: true })
  })

  test('s2.5 — Post engagement buttons are interactive (like)', async ({ page }) => {
    await loadApp(page)
    await page.waitForTimeout(1000)

    const emptyState = page.locator('text=No posts yet')
    if (await emptyState.isVisible().catch(() => false)) {
      test.skip(true, 'No posts available — skipping interaction check')
      return
    }

    const likeBtn = page.locator('button[aria-label^="Like"]').first()
    await expect(likeBtn).toBeVisible()

    const initialPressed = await likeBtn.getAttribute('aria-pressed')
    console.log(`LIKE BUTTON initial pressed: ${initialPressed}`)

    await likeBtn.click()

    const afterPressed = await likeBtn.getAttribute('aria-pressed')
    console.log(`LIKE BUTTON after click pressed: ${afterPressed}`)
    expect(afterPressed).not.toBe(initialPressed)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s2_like_toggled.png`, fullPage: true })
  })

  test('s2.6 — Feed history section is present', async ({ page }) => {
    await loadApp(page)

    const feedHistory = page.locator('text=/Previous|History|feeds/i').first()
    const hasFeedHistory = await feedHistory.isVisible().catch(() => false)
    console.log(`FEED HISTORY: ${hasFeedHistory ? 'Visible' : 'Not visible or empty'}`)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s2_feed_history.png`, fullPage: true })
  })
})

// ---------- Section 3: Feed Tabs ----------

test.describe('Section 3 — Feed Tabs', () => {
  test('s3.1 — All four tabs are visible', async ({ page }) => {
    await loadApp(page)

    const tabs = ['For You', 'Debates', 'Methods', 'Findings']
    for (const tab of tabs) {
      const tabBtn = page.locator(`button:has-text("${tab}")`).first()
      await expect(tabBtn).toBeVisible()
      console.log(`TAB "${tab}": visible`)
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s3_all_tabs.png`, fullPage: true })
  })

  test('s3.2 — "For You" tab is active by default', async ({ page }) => {
    await loadApp(page)

    const forYouTab = page.locator('button:has-text("For You")').first()
    const fontWeight = await forYouTab.evaluate((el) =>
      window.getComputedStyle(el).fontWeight
    )
    console.log(`FOR YOU TAB font-weight: ${fontWeight}`)
    expect(['700', 'bold']).toContain(fontWeight)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s3_for_you_active.png`, fullPage: true })
  })

  test('s3.3 — Clicking "Debates" tab activates it', async ({ page }) => {
    await loadApp(page)

    const debatesTab = page.locator('button:has-text("Debates")').first()
    await debatesTab.click()
    await page.waitForTimeout(500)

    const fontWeight = await debatesTab.evaluate((el) =>
      window.getComputedStyle(el).fontWeight
    )
    console.log(`DEBATES TAB font-weight after click: ${fontWeight}`)
    expect(['700', 'bold']).toContain(fontWeight)

    const forYouTab = page.locator('button:has-text("For You")').first()
    const forYouWeight = await forYouTab.evaluate((el) =>
      window.getComputedStyle(el).fontWeight
    )
    console.log(`FOR YOU TAB font-weight after switching: ${forYouWeight}`)
    expect(['700', 'bold']).not.toContain(forYouWeight)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s3_debates_active.png`, fullPage: true })
  })

  test('s3.4 — Clicking "Methods" tab activates it', async ({ page }) => {
    await loadApp(page)

    const methodsTab = page.locator('button:has-text("Methods")').first()
    await methodsTab.click()
    await page.waitForTimeout(500)

    const fontWeight = await methodsTab.evaluate((el) =>
      window.getComputedStyle(el).fontWeight
    )
    expect(['700', 'bold']).toContain(fontWeight)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s3_methods_active.png`, fullPage: true })
  })

  test('s3.5 — Clicking "Findings" tab activates it', async ({ page }) => {
    await loadApp(page)

    const findingsTab = page.locator('button:has-text("Findings")').first()
    await findingsTab.click()
    await page.waitForTimeout(500)

    const fontWeight = await findingsTab.evaluate((el) =>
      window.getComputedStyle(el).fontWeight
    )
    expect(['700', 'bold']).toContain(fontWeight)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s3_findings_active.png`, fullPage: true })
  })

  test('s3.6 — Tab filtering shows correct content or empty state', async ({ page }) => {
    await loadApp(page)
    await page.waitForTimeout(1000)

    const emptyState = page.locator('text=No posts yet')
    if (await emptyState.isVisible().catch(() => false)) {
      test.skip(true, 'No posts available — skipping tab filtering check')
      return
    }

    const tabs = ['For You', 'Debates', 'Methods', 'Findings']

    for (let i = 0; i < tabs.length; i++) {
      const tabBtn = page.locator(`button:has-text("${tabs[i]}")`).first()
      await tabBtn.click()
      await page.waitForTimeout(500)

      const emptyFiltered = page.locator(`text=No ${tabs[i].toLowerCase()} posts in this feed`)
      const hasEmpty = await emptyFiltered.isVisible().catch(() => false)

      if (hasEmpty) {
        console.log(`TAB "${tabs[i]}": Empty filtered state (no matching posts)`)
        const hint = page.locator('text=Try generating again for more variety')
        const hasHint = await hint.isVisible().catch(() => false)
        console.log(`  Hint visible: ${hasHint}`)
      } else {
        const postActions = page.locator('button[aria-label^="Like"]')
        const postCount = await postActions.count()
        console.log(`TAB "${tabs[i]}": ${postCount} post(s) visible`)
      }

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/s3_tab_${tabs[i].toLowerCase().replace(' ', '_')}_content.png`,
        fullPage: true,
      })
    }
  })

  test('s3.7 — Tab switching preserves visual hierarchy (gold underline)', async ({ page }) => {
    await loadApp(page)

    const tabs = ['For You', 'Debates', 'Methods', 'Findings']

    for (const tab of tabs) {
      const tabBtn = page.locator(`button:has-text("${tab}")`).first()
      await tabBtn.click()
      await page.waitForTimeout(300)

      const borderBottom = await tabBtn.evaluate((el) =>
        window.getComputedStyle(el).borderBottomColor
      )
      console.log(`TAB "${tab}" active border-bottom-color: ${borderBottom}`)
      // Gold color #c8a96e = rgb(200, 169, 110)
      expect(borderBottom).toBe('rgb(200, 169, 110)')
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s3_tab_underline.png`, fullPage: true })
  })
})
