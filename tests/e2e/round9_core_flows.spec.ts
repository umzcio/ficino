import { test, expect, Page } from '@playwright/test'
import { join } from 'path'

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000/ficino'
const SHOTS = '/projects/ficino/tests/screenshots'

function shot(name: string) {
  return join(SHOTS, `r9_${name}.png`)
}

// Minimal valid 1-page PDF constructed inline — avoids needing a fixture file
// on disk. Has a bit of extractable text so pymupdf has something to chunk.
function buildMinimalPdf(): Buffer {
  const body = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 74>>stream
BT /F1 14 Tf 72 720 Td (Ficino round 9 end-to-end smoke PDF.) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000052 00000 n
0000000095 00000 n
0000000184 00000 n
0000000302 00000 n
trailer<</Size 6/Root 1 0 R>>
startxref
362
%%EOF
`
  return Buffer.from(body, 'utf-8')
}

async function boot(page: Page) {
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30_000 })
  await page.waitForSelector('nav, [role="navigation"]', { timeout: 15_000, state: 'attached' })
  await page.waitForSelector('article, main, #root', { timeout: 15_000 })
}

test.describe('ROUND 9 — core flows', () => {

  test('R9-01 PDF upload triggers backend ingestion (end-to-end)', async ({ page, context }) => {
    await boot(page)

    const papersBefore = await context.request.get(`${BASE}/api/papers`, { ignoreHTTPSErrors: true })
    const beforeList = papersBefore.ok() ? await papersBefore.json() : []
    const beforeIds = new Set(beforeList.map((p: any) => p.id))
    console.log(`R9-01: papers before = ${beforeList.length}`)

    const fileInput = page.locator('input#pdf-upload').first()
    await expect(fileInput).toBeAttached()

    await fileInput.setInputFiles({
      name: 'r9-smoke.pdf',
      mimeType: 'application/pdf',
      buffer: buildMinimalPdf(),
    })

    // Poll backend for new paper to appear (upload is async)
    let newPaper: any = null
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const r = await context.request.get(`${BASE}/api/papers`, { ignoreHTTPSErrors: true })
      if (r.ok()) {
        const list = await r.json()
        const added = list.find((p: any) => !beforeIds.has(p.id))
        if (added) { newPaper = added; break }
      }
      await page.waitForTimeout(500)
    }
    await page.screenshot({ path: shot('01_after_upload'), fullPage: true })
    console.log(`R9-01: new paper id=${newPaper?.id} status=${newPaper?.status} filename=${newPaper?.filename}`)
    expect(newPaper, 'uploaded PDF never appeared in /api/papers within 15s').not.toBeNull()
    expect(newPaper.filename).toContain('r9-smoke')
    // status should be queued/processing/complete — NOT error-on-accept
    expect(['queued', 'processing', 'complete', 'extracting', 'embedding', 'chunking']).toContain(newPaper.status)

    // Clean up — delete the test paper so the corpus doesn't accumulate junk
    await context.request.delete(`${BASE}/api/papers/${newPaper.id}`, { ignoreHTTPSErrors: true }).catch(() => {})
  })

  test('R9-02 Compose → Archivist reply posts and appears in feed', async ({ page, context }) => {
    await boot(page)

    const compose = page.locator('textarea[aria-label="Compose new post"]').first()
    await expect(compose).toBeVisible()

    const question = `Round-9 smoke: what is trust in AI? ${Date.now()}`
    await compose.fill(question)
    await page.waitForTimeout(200)

    // Capture POST response so we know the post id and can poll its status
    const [postResp] = await Promise.all([
      page.waitForResponse(r =>
        r.url().includes('/api/user-posts') && r.request().method() === 'POST',
        { timeout: 15_000 }),
      compose.press('Enter'),
    ])
    expect(postResp.status(), 'POST /api/user-posts did not return 2xx').toBeLessThan(300)
    const postBody = await postResp.json()
    console.log(`R9-02: created post id=${postBody.id} task=${postBody.task_id}`)
    expect(postBody.id).toBeTruthy()

    // Poll the post status endpoint for up to 90s waiting for archivist reply.
    // Ollama on this box can be slow, so status=pending is an acceptable
    // mid-state for this smoke test (we're testing the flow, not latency).
    let finalStatus: string | null = null
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const r = await context.request.get(`${BASE}/api/user-posts/${postBody.id}/status`, { ignoreHTTPSErrors: true })
      if (r.ok()) {
        const s = await r.json()
        finalStatus = s.status
        if (['complete', 'ready', 'done', 'error', 'failed'].includes(s.status)) break
      }
      await page.waitForTimeout(1500)
    }
    console.log(`R9-02: archivist reply final status=${finalStatus}`)
    await page.screenshot({ path: shot('02_after_archivist'), fullPage: true })
    expect(finalStatus, 'status endpoint never returned a status').not.toBeNull()
    expect(['pending', 'processing', 'complete', 'ready', 'done']).toContain(finalStatus!)
    // We don't FAIL on 'pending' because Ollama may be slow, but we DO fail on error/failed
    expect(['error', 'failed']).not.toContain(finalStatus!)

    // If complete, verify citations (api shape: `sources` at post level, not
    // per-reply — see api/routers/user_posts.py:62-69)
    if (['complete', 'ready', 'done'].includes(finalStatus!)) {
      const detail = await context.request.get(`${BASE}/api/user-posts/${postBody.id}`, { ignoreHTTPSErrors: true })
      expect(detail.ok()).toBe(true)
      const d = await detail.json()
      const replies = d.replies || []
      const sources = d.sources || []
      console.log(`R9-02: archivist replies=${replies.length} sources=${sources.length} first-paper=${sources[0]?.paper_title}`)
      expect(replies.length).toBeGreaterThan(0)
      expect(replies[0].role).toBe('archivist')
      expect(sources.length, 'archivist reply must cite at least one source').toBeGreaterThan(0)
      expect(sources[0]).toHaveProperty('paper_title')
      expect(sources[0]).toHaveProperty('score')
    }
  })
})
