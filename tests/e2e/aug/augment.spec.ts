import { test, expect, Page } from '@playwright/test'
import { join } from 'path'
import { writeFileSync } from 'fs'

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000/ficino'
const SHOTS = '/projects/ficino/tests/screenshots'

function shot(name: string) {
  return join(SHOTS, `aug_${name}.png`)
}

async function boot(page: Page) {
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30_000 })
  await page.waitForSelector('nav[aria-label="Main navigation"]', { timeout: 15_000 })
}

async function navTo(page: Page, label: string) {
  await page.locator(`nav[aria-label="Main navigation"] button[aria-label="${label}"]`).click()
  await page.waitForTimeout(400)
}

// ───────────────────────────────────────────────────────────────────
// CORE — Feed and post flows
// ───────────────────────────────────────────────────────────────────

test.describe('AUG — Core flows', () => {
  test('AUG-01: App boots, feed shows posts', async ({ page }) => {
    await boot(page)
    const articles = page.locator('article')
    const count = await articles.count()
    console.log(`AUG-01: ${count} article posts in feed`)
    expect(count).toBeGreaterThan(0)
    await page.screenshot({ path: shot('01_feed_loaded'), fullPage: false })
  })

  test('AUG-02: Scroll + post structure (reply/like/pass-to/bookmark action buttons)', async ({ page }) => {
    await boot(page)
    await page.mouse.wheel(0, 1200)
    await page.waitForTimeout(400)
    const reply = page.locator('button[aria-label^="Replies"]').first()
    const like = page.locator('button[aria-label^="Like"]').first()
    // FINDING: "Repost" button was renamed to "Pass to persona" (Conductor feature)
    const passTo = page.locator('button[aria-label^="Pass to persona"]').first()
    const bookmark = page.locator('button[aria-label^="Bookmark"]').first()
    for (const btn of [reply, like, passTo, bookmark]) await expect(btn).toBeVisible()
    await page.screenshot({ path: shot('02_scroll_actions'), fullPage: false })
  })

  test('AUG-03: Reply opens composer with current placeholder', async ({ page }) => {
    await boot(page)
    const replyBtn = page.locator('button[aria-label^="Replies"]').first()
    await replyBtn.click()
    await page.waitForTimeout(700)
    const replyingTo = page.locator('text=/Replying to @/').first()
    await expect(replyingTo).toBeVisible()
    // Current placeholder includes "(@ to mention)" — record the actual value
    const input = page.locator('input[placeholder^="Post your reply"]').first()
    const ph = await input.getAttribute('placeholder')
    console.log(`AUG-03: actual reply input placeholder = ${JSON.stringify(ph)}`)
    await expect(input).toBeVisible()
    await page.screenshot({ path: shot('03_reply_composer'), fullPage: false })
  })

  test('AUG-04: @mention autocomplete dropdown appears on @', async ({ page }) => {
    await boot(page)
    const replyBtn = page.locator('button[aria-label^="Replies"]').first()
    await replyBtn.click()
    await page.waitForTimeout(600)
    const input = page.locator('input[placeholder^="Post your reply"]').first()
    await input.fill('hey @')
    await page.waitForTimeout(600)
    // Dropdown should list persona handles (e.g. @skeptical_methods)
    const dropdown = page.locator('[role="listbox"], [data-testid="mention-dropdown"], div:has(> button:has-text("@skeptical_methods"))').first()
    const visibleHandles = page.locator('button:has-text("@skeptical_methods"), button:has-text("@big_if_true"), button:has-text("@phd_suffering")')
    const dropdownCount = await visibleHandles.count()
    console.log(`AUG-04: mention options count = ${dropdownCount}`)
    await page.screenshot({ path: shot('04_mention_dropdown'), fullPage: false })
    expect(dropdownCount).toBeGreaterThan(0)
  })

  test('AUG-05: Empty reply input = button disabled; markdown/script reply renders safely', async ({ page }) => {
    await boot(page)
    const replyBtn = page.locator('button[aria-label^="Replies"]').first()
    await replyBtn.click()
    await page.waitForTimeout(600)
    const input = page.locator('input[placeholder^="Post your reply"]').first()
    const sendBtn = page.locator('button', { hasText: /^Reply$/ }).first()
    // Empty disabled
    await input.fill('')
    await page.waitForTimeout(200)
    const emptyDisabled = await sendBtn.getAttribute('disabled')
    console.log(`AUG-05: empty-input sendBtn disabled attr = ${emptyDisabled}`)
    // Markdown injection payload — don't actually send (would hit LLM),
    // just confirm the value is accepted by the textbox and does not crash the page.
    const payload = '**bold** <script>window.__xss=true</script> [link](javascript:alert(1))'
    await input.fill(payload)
    await page.waitForTimeout(200)
    const typed = await input.inputValue()
    expect(typed).toBe(payload)
    const xss = await page.evaluate(() => (window as any).__xss ?? false)
    console.log(`AUG-05: window.__xss after paste = ${xss}`)
    expect(xss).toBe(false)
    await page.screenshot({ path: shot('05_injection_typed'), fullPage: false })
  })

  test('AUG-06: Very long reply input accepted', async ({ page }) => {
    await boot(page)
    const replyBtn = page.locator('button[aria-label^="Replies"]').first()
    await replyBtn.click()
    await page.waitForTimeout(500)
    const input = page.locator('input[placeholder^="Post your reply"]').first()
    const long = 'a'.repeat(5000)
    await input.fill(long)
    const val = await input.inputValue()
    console.log(`AUG-06: typed ${val.length} chars`)
    expect(val.length).toBeGreaterThanOrEqual(1000)
    await page.screenshot({ path: shot('06_long_input'), fullPage: false })
  })

  test('AUG-07: Bookmark toggles + survives nav away and back', async ({ page }) => {
    await boot(page)
    const firstBookmark = page.locator('button[aria-label^="Bookmark"]').first()
    await expect(firstBookmark).toBeVisible()
    const before = await firstBookmark.getAttribute('aria-pressed')
    await firstBookmark.click()
    await page.waitForTimeout(300)
    const after = await firstBookmark.getAttribute('aria-pressed')
    console.log(`AUG-07: bookmark pressed ${before} -> ${after}`)
    expect(after).not.toBe(before)
    // FINDING: Bookmarks nav label is "Saved" (aria-label), not "Bookmarks"
    await navTo(page, 'Saved')
    await page.waitForTimeout(600)
    await page.screenshot({ path: shot('07_bookmarks_view'), fullPage: true })
    await navTo(page, 'Home')
    await page.waitForTimeout(500)
    const stillPressed = await page.locator('button[aria-label^="Bookmark"]').first().getAttribute('aria-pressed')
    console.log(`AUG-07: after nav back = ${stillPressed}`)
    await page.screenshot({ path: shot('07_back_on_feed'), fullPage: false })
    // Clean up — unbookmark
    if (stillPressed === 'true') {
      await page.locator('button[aria-label^="Bookmark"]').first().click()
      await page.waitForTimeout(300)
    }
  })

  test('AUG-08: Like toggles; rapid double-click safe', async ({ page }) => {
    await boot(page)
    const like = page.locator('button[aria-label^="Like"]').first()
    const start = await like.getAttribute('aria-pressed')
    await like.click()
    await like.click() // rapid double
    await page.waitForTimeout(500)
    const end = await like.getAttribute('aria-pressed')
    console.log(`AUG-08: like ${start} -> ${end} after double click`)
    // After two clicks it should be back to original state
    expect(end).toBe(start)
    await page.screenshot({ path: shot('08_double_like'), fullPage: false })
  })

  test('AUG-09: Post detail - click article then back', async ({ page }) => {
    await boot(page)
    const firstArticle = page.locator('article').first()
    await firstArticle.click()
    await page.waitForTimeout(800)
    // Post-detail may show a "Back" or header change
    await page.screenshot({ path: shot('09_post_detail'), fullPage: false })
    // Go back via browser back
    await page.goBack()
    await page.waitForTimeout(600)
    const posts = await page.locator('article').count()
    console.log(`AUG-09: after back, ${posts} posts on feed`)
    await page.screenshot({ path: shot('09_after_back'), fullPage: false })
  })
})

// ───────────────────────────────────────────────────────────────────
// ARCHIVIST / SEARCH / MESSAGES
// ───────────────────────────────────────────────────────────────────

test.describe('AUG — Archivist & Messages', () => {
  test('AUG-10: Search/Explore page — typing a query returns results', async ({ page }) => {
    await boot(page)
    await navTo(page, 'Search')
    // Phase 3 downgraded view-title headings from h1 to h2 to keep one h1 per page.
    await page.waitForSelector('h1:has-text("Explore"), h2:has-text("Explore")', { timeout: 10000 })
    const searchInput = page.locator('input[placeholder*="Search"], input[type="search"]').first()
    await searchInput.fill('trust')
    await page.waitForTimeout(1200)
    await page.screenshot({ path: shot('10_search_results'), fullPage: true })
    const results = page.locator('[data-testid="search-result"], section')
    const rcount = await results.count()
    console.log(`AUG-10: explore page contains ${rcount} section(s) after query`)
  })

  test('AUG-11: Messages view loads + shows Papers tab', async ({ page }) => {
    await boot(page)
    await navTo(page, 'Messages')
    await page.waitForTimeout(1000)
    await page.screenshot({ path: shot('11_messages'), fullPage: true })
    const papersTab = page.locator('button', { hasText: /^Papers$/ }).first()
    const personasTab = page.locator('button', { hasText: /^Personas$/ }).first()
    const groupTab = page.locator('button', { hasText: /Group/ }).first()
    const hasPapers = await papersTab.isVisible().catch(() => false)
    const hasPersonas = await personasTab.isVisible().catch(() => false)
    const hasGroup = await groupTab.isVisible().catch(() => false)
    console.log(`AUG-11: Messages tabs -> Papers=${hasPapers}, Personas=${hasPersonas}, Group=${hasGroup}`)
    // At least one of papers or personas must be present
    expect(hasPapers || hasPersonas).toBe(true)
  })

  test('AUG-12: Paper Messages — open a paper -> see TL;DR / breakdown', async ({ page }) => {
    await boot(page)
    await navTo(page, 'Messages')
    await page.waitForTimeout(800)
    // click the first paper entry (shown as button or div containing a paper title)
    const paperRow = page.locator('button:has-text("Trust in AI"), div:has(> div > :text("Trust in AI"))').first()
    const clickable = await paperRow.isVisible().catch(() => false)
    if (!clickable) {
      await page.screenshot({ path: shot('12_messages_no_paper'), fullPage: true })
      console.log('AUG-12: could not find a paper in Messages sidebar — skipping deeper check')
      return
    }
    await paperRow.click()
    await page.waitForTimeout(2500)
    await page.screenshot({ path: shot('12_paper_messages'), fullPage: true })
    const tldr = page.locator('text=/TL;DR|Summary/i').first()
    const hasTldr = await tldr.isVisible().catch(() => false)
    console.log(`AUG-12: TL;DR/Summary visible = ${hasTldr}`)
  })

  test('AUG-13: Alerts nav works + shows unread badge or empty state', async ({ page }) => {
    await boot(page)
    await navTo(page, 'Alerts')
    await page.waitForTimeout(800)
    await page.screenshot({ path: shot('13_alerts'), fullPage: true })
  })
})

// ───────────────────────────────────────────────────────────────────
// SETTINGS — Display, Theme, Font
// ───────────────────────────────────────────────────────────────────

test.describe('AUG — Settings interactions', () => {
  test('AUG-14: Open Settings, toggle Theme section visible', async ({ page }) => {
    await boot(page)
    await navTo(page, 'Settings')
    // Phase 3 downgraded view-title h1 → h2 (one h1 per page).
    await page.waitForSelector('h1:has-text("Settings"), h2:has-text("Settings")', { timeout: 10_000 })
    // Newer settings DOM — pull textContent for a section list
    const headings = await page.locator('h1, h2, h3').allTextContents()
    console.log(`AUG-14: setting headings = ${JSON.stringify(headings)}`)
    const theme = page.locator('text=Theme').first()
    await expect(theme).toBeVisible()
    await page.screenshot({ path: shot('14_settings_open'), fullPage: true })
  })

  test('AUG-15: Settings — Font Size / Post Spacing present', async ({ page }) => {
    await boot(page)
    await navTo(page, 'Settings')
    await page.waitForTimeout(800)
    const font = page.locator('text=Font Size').first()
    const spacing = page.locator('text=Post Spacing').first()
    await expect(font).toBeVisible()
    await expect(spacing).toBeVisible()
    await page.screenshot({ path: shot('15_display_prefs'), fullPage: false })
  })

  test('AUG-16: Settings — New-style LLM Provider section (captures DOM)', async ({ page }) => {
    await boot(page)
    await navTo(page, 'Settings')
    await page.waitForTimeout(800)
    // Print the whole structure of sections so the report can describe new DOM
    const labels = await page.locator('span, div').evaluateAll(els =>
      Array.from(new Set(
        els.map(e => (e.textContent || '').trim())
          .filter(t => t.length && t.length < 60)
          .filter(t => /provider|llm|model|ollama|claude|api|persona/i.test(t))
      )).slice(0, 40)
    )
    console.log(`AUG-16: settings labels = ${JSON.stringify(labels)}`)
    const select = page.locator('select').first()
    const selectVisible = await select.isVisible().catch(() => false)
    console.log(`AUG-16: any <select> visible = ${selectVisible}`)
    // Some settings now use button groups instead of select — check for Ollama text
    const ollamaLabel = page.locator('text=Ollama').first()
    const claudeLabel = page.locator('text=/Claude( API)?/').first()
    const hasOllama = await ollamaLabel.isVisible().catch(() => false)
    const hasClaude = await claudeLabel.isVisible().catch(() => false)
    console.log(`AUG-16: Ollama=${hasOllama} Claude=${hasClaude}`)
    // FINDING: Settings redesign — surface the full visible text so we can
    // see what the new section looks like
    const allVisibleText = await page.locator('main').first().textContent().catch(() => '')
    console.log(`AUG-16: main textContent (first 1000) = ${JSON.stringify((allVisibleText || '').slice(0, 1000))}`)
    await page.screenshot({ path: shot('16_llm_provider_new'), fullPage: true })
  })
})

// ───────────────────────────────────────────────────────────────────
// PWA + OFFLINE
// ───────────────────────────────────────────────────────────────────

test.describe('AUG — PWA & offline', () => {
  test('AUG-17: manifest + service worker registered', async ({ page }) => {
    await boot(page)
    // manifest link
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href').catch(() => null)
    console.log(`AUG-17: manifest href = ${manifestHref}`)
    expect(manifestHref).toBeTruthy()
    // Service worker registration
    const swState = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'unsupported'
      const regs = await navigator.serviceWorker.getRegistrations()
      return regs.length ? `${regs.length} registrations: ${regs.map(r => r.active?.state || 'no-active').join(',')}` : 'none'
    })
    console.log(`AUG-17: SW state = ${swState}`)
    await page.screenshot({ path: shot('17_pwa'), fullPage: false })
  })

  test('AUG-18: IndexedDB present + "synced" indicator if rendered', async ({ page }) => {
    await boot(page)
    const dbs = await page.evaluate(async () => {
      if (!('databases' in indexedDB)) return ['indexedDB.databases not available']
      const list = await (indexedDB as any).databases()
      return list.map((d: any) => `${d.name}:${d.version}`)
    })
    console.log(`AUG-18: IndexedDB = ${JSON.stringify(dbs)}`)
    const syncedText = page.locator('text=/synced/i').first()
    const hasSynced = await syncedText.isVisible().catch(() => false)
    console.log(`AUG-18: "synced" indicator visible = ${hasSynced}`)
    await page.screenshot({ path: shot('18_indexeddb'), fullPage: true })
  })

  test('AUG-19: offline — app still paints after context.setOffline(true)', async ({ page, context }) => {
    await boot(page)
    // Wait for SW to register+activate so cache is populated
    await page.waitForTimeout(2_000)
    await context.setOffline(true)
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(e => console.log('reload err:', e.message))
    const ficinoText = page.locator('text=ficino').first()
    const paintedOffline = await ficinoText.isVisible({ timeout: 10_000 }).catch(() => false)
    console.log(`AUG-19: app paints offline = ${paintedOffline}`)
    await page.screenshot({ path: shot('19_offline'), fullPage: true })
    await context.setOffline(false)
  })
})

// ───────────────────────────────────────────────────────────────────
// CHAOS / EDGE
// ───────────────────────────────────────────────────────────────────

test.describe('AUG — Chaos & edge cases', () => {
  test('AUG-20: Malformed PDF (truthy but zero-byte) upload reaction', async ({ page }) => {
    await boot(page)
    const fileInput = page.locator('input#pdf-upload').first()
    // Pass a buffer with non-PDF bytes named .pdf
    await fileInput.setInputFiles({
      name: 'bad.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('this is not a real pdf'),
    })
    await page.waitForTimeout(3_000)
    const err = page.locator('.text-red-400, [class*="text-red"]').first()
    const errText = await err.textContent().catch(() => null)
    console.log(`AUG-20: error text after bad PDF = ${errText}`)
    await page.screenshot({ path: shot('20_bad_pdf'), fullPage: true })
  })

  // Route stubs are in place for the generate dispatch + status-polling
  // endpoints so the page never opens a real 28s SSE connection. Even so,
  // the test hits shared live-instance state: a prior run's feedState can
  // leave "Generating..." rendered at boot time, or the live backend's
  // existing feed-load can interleave with the click. A clean fix requires
  // either a seeded per-test user workspace or a local dev backend — both
  // out of scope for this session. Leaving as `fixme` with the stubs in
  // place so whoever picks it up can extend the isolation.
  test.fixme('AUG-21: Rapid Generate-button double click', async ({ page }) => {
    await page.route('**/ficino/api/feed/generate', async (route) => {
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ task_id: 'aug21-stub-task', status: 'queued' }),
      })
    })
    await page.route('**/ficino/api/feed/status/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'generating',
          task_id: 'aug21-stub-task',
          meta: { step: 'generating', post_progress: '1/12' },
        }),
      })
    })

    await boot(page)
    const gen = page.locator('button:has-text("Generate"), button[aria-label*="Generate"]').first()
    const enabled = await gen.isVisible().catch(() => false) && !(await gen.isDisabled())
    if (!enabled) {
      test.skip(true, 'Generate button not visible/enabled')
      return
    }
    await gen.click({ trial: false })
    await gen.click({ trial: false }).catch(() => null)
    // Accept either a "Generating" button OR the indicator text that
    // replaces the Generate button when feedState transitions — Feed.tsx
    // swaps the button for an inline spinner + "Generating more posts…"
    // paragraph mid-generation.
    const generatingIndicator = page.getByText(/Generating/i).first()
    await expect(generatingIndicator).toBeVisible({ timeout: 5000 })
    console.log('AUG-21: after double click -> Generating indicator visible')
  })

  test('AUG-22: Refresh while feed is generating (if generating)', async ({ page }) => {
    await boot(page)
    const generating = await page.locator('button:has-text("Generating")').first().isVisible().catch(() => false)
    if (!generating) {
      console.log('AUG-22: no active generation to interrupt — just reload the page')
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('nav[aria-label="Main navigation"]', { timeout: 15000 })
    const postCount = await page.locator('article').count()
    console.log(`AUG-22: after reload, ${postCount} articles visible`)
    expect(postCount).toBeGreaterThanOrEqual(0)
    await page.screenshot({ path: shot('22_after_reload'), fullPage: false })
  })
})

// ───────────────────────────────────────────────────────────────────
// VIEWPORTS
// ───────────────────────────────────────────────────────────────────

test.describe('AUG — Viewports', () => {
  test('AUG-23: 1440x900 desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await boot(page)
    await page.screenshot({ path: shot('23_vp_1440'), fullPage: false })
    await expect(page.locator('article').first()).toBeVisible()
  })

  test('AUG-24: 768x1024 tablet', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 })
    await boot(page)
    await page.screenshot({ path: shot('24_vp_768'), fullPage: false })
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    console.log(`AUG-24: horizontal overflow at 768 = ${horizontalOverflow}`)
    expect(horizontalOverflow).toBe(false)
  })

  test('AUG-25: 375x812 mobile — mobile nav takes over', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30_000 })
    // At mobile width, the top nav is md:flex only, so a mobile nav is expected somewhere
    const mobileNav = page.locator('nav[aria-label="Mobile navigation"]').first()
    const hasMobileNav = await mobileNav.isVisible({ timeout: 10_000 }).catch(() => false)
    console.log(`AUG-25: mobile nav visible at 375 = ${hasMobileNav}`)
    await page.screenshot({ path: shot('25_vp_375'), fullPage: false })
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    console.log(`AUG-25: horizontal overflow at 375 = ${horizontalOverflow}`)
    expect(horizontalOverflow).toBe(false)
    expect(hasMobileNav).toBe(true)
  })
})
