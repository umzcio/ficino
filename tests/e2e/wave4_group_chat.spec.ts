import { test, expect, Page, APIRequestContext } from '@playwright/test'
import { join } from 'path'

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000/ficino'
const SHOTS = '/projects/ficino/tests/screenshots'

function shot(name: string) {
  return join(SHOTS, `w4_group_chat_${name}.png`)
}

// Minimal valid 1-page PDF constructed inline (same shape as
// round9_core_flows.spec.ts's buildMinimalPdf) — avoids needing a fixture
// file on disk while still giving pymupdf a bit of extractable text.
function buildMinimalPdf(label: string): Buffer {
  const body = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 74>>stream
BT /F1 14 Tf 72 720 Td (Ficino wave-4 group chat smoke PDF, ${label}.) Tj ET
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

// Uploads one PDF through the corpus sidebar's file input and polls the
// backend until it reaches 'complete'. The group-chat create endpoint
// (api/routers/messages.py create_group_chat) needs at least 2 *complete*
// papers — a still-processing paper 404s the create call — so this spec
// needs two papers fully through the ingestion pipeline before it can drive
// the modal, unlike round9's R9-01 which only asserts the upload lands.
async function uploadAndWaitComplete(
  page: Page, request: APIRequestContext, filename: string, label: string,
): Promise<{ id: string; filename: string }> {
  const before = await request.get(`${BASE}/api/papers`, { ignoreHTTPSErrors: true })
  const beforeList = before.ok() ? await before.json() : []
  const beforeIds = new Set(beforeList.map((p: any) => p.id))

  const fileInput = page.locator('input#pdf-upload').first()
  await expect(fileInput).toBeAttached()
  await fileInput.setInputFiles({
    name: filename,
    mimeType: 'application/pdf',
    buffer: buildMinimalPdf(label),
  })

  let newPaper: any = null
  const uploadDeadline = Date.now() + 15_000
  while (Date.now() < uploadDeadline) {
    const r = await request.get(`${BASE}/api/papers`, { ignoreHTTPSErrors: true })
    if (r.ok()) {
      const list = await r.json()
      const added = list.find((p: any) => !beforeIds.has(p.id) && p.filename === filename)
      if (added) { newPaper = added; break }
    }
    await page.waitForTimeout(500)
  }
  expect(newPaper, `${filename} never appeared in /api/papers within 15s`).not.toBeNull()

  let status = newPaper.status
  const completeDeadline = Date.now() + 60_000
  while (Date.now() < completeDeadline && status !== 'complete' && status !== 'error') {
    await page.waitForTimeout(1000)
    const r = await request.get(`${BASE}/api/papers/${newPaper.id}`, { ignoreHTTPSErrors: true })
    if (r.ok()) {
      status = (await r.json()).status
    }
  }
  expect(status, `${filename} never reached 'complete' within 60s (last status=${status})`).toBe('complete')
  return newPaper
}

test.describe('WAVE 4 — group chat creation', () => {
  test('W4-01 create a group chat via the New Group Chat modal (FE-4)', async ({ page, context }) => {
    // Two uploads + 60s-each completion polling + up to 90s of synthesis
    // polling comfortably exceeds the config default of 60s.
    test.setTimeout(300_000)
    await boot(page)

    const paperA = await uploadAndWaitComplete(page, context.request, `w4-group-a-${Date.now()}.pdf`, 'paper A')
    const paperB = await uploadAndWaitComplete(page, context.request, `w4-group-b-${Date.now()}.pdf`, 'paper B')
    console.log(`W4-01: uploaded papers ${paperA.id} / ${paperB.id}`)

    // Navigate to Messages > Groups tab
    await page.getByRole('button', { name: 'Messages' }).click()
    await page.getByRole('tab', { name: 'Groups' }).click()

    // Either CTA opens the same modal: the empty-state "Create Group Chat"
    // button (no groups yet) or the trailing "New Group Chat" button below
    // an existing list.
    const newGroupButton = page.getByRole('button', { name: /group chat/i }).first()
    await expect(newGroupButton).toBeVisible()
    await newGroupButton.click()

    const dialog = page.getByRole('dialog', { name: 'New Group Chat' })
    await expect(dialog).toBeVisible()

    const groupName = `W4 smoke synthesis ${Date.now()}`
    await dialog.getByLabel('Name').fill(groupName)

    await dialog.getByText(paperA.filename).click()
    await dialog.getByText(paperB.filename).click()
    await expect(dialog.getByText('2 selected')).toBeVisible()

    const createButton = dialog.getByRole('button', { name: 'Create' })
    await expect(createButton).toBeEnabled()

    const [createResp] = await Promise.all([
      page.waitForResponse(r =>
        r.url().includes('/api/messages/groups') && r.request().method() === 'POST',
        { timeout: 15_000 }),
      createButton.click(),
    ])
    expect(createResp.status(), 'POST /api/messages/groups did not return a 2xx/202').toBeLessThan(300)
    const createBody = await createResp.json()
    console.log(`W4-01: created group chat synthesis_id=${createBody.synthesis_id} task=${createBody.task_id}`)
    expect(createBody.synthesis_id).toBeTruthy()

    // Modal closes and the app navigates straight to the new group view.
    // GroupChatView's header always renders a "Go back" button regardless
    // of whether the synthesis has finished — assert on that stable marker
    // rather than the chat name. The backend only inserts the
    // corpus_syntheses row when the Celery task completes (there's no
    // upfront placeholder row), so the view's first fetches right after
    // create legitimately 404 — GroupChatView treats those as pending and
    // retries on a bounded window (R10 FE-4 follow-up), showing the
    // "Synthesizing…" hint until the row lands.
    await expect(dialog).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Go back' })).toBeVisible({ timeout: 10_000 })
    // Immediately after create the view must be in one of exactly two
    // legitimate states: the Synthesizing hint (row not written yet) or —
    // if the worker was uncommonly fast — the finished synthesis. It must
    // NEVER be the failure card (the pre-fix behavior).
    await expect(
      page.getByText('Synthesizing…').or(page.getByText('Papers in this conversation')).first()
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Synthesis failed to load')).not.toBeVisible()
    await page.screenshot({ path: shot('01_after_create'), fullPage: true })

    // Ollama synthesis can be slow — poll the backend directly for up to
    // 90s. A 404 is the documented pending state (row not written until
    // the Celery task completes); a 5xx is a real backend failure and
    // must hard-fail the spec instead of being lumped in with pending.
    let finalChat: any = null
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const r = await context.request.get(`${BASE}/api/messages/groups/${createBody.synthesis_id}`, { ignoreHTTPSErrors: true })
      expect(r.status(), 'backend error during synthesis poll').toBeLessThan(500)
      if (r.ok()) {
        const body = await r.json()
        if (Array.isArray(body.messages) && body.messages.length > 0) { finalChat = body; break }
      }
      await page.waitForTimeout(2000)
    }
    console.log(`W4-01: final synthesis message count=${finalChat?.messages?.length ?? 0}`)

    if (finalChat) {
      expect(finalChat.name).toBe(groupName)
      expect(Object.keys(finalChat.papers)).toHaveLength(2)
      // MessagesView has no URL-based routing (pure in-memory SPA state),
      // so a page.reload() would land back on the default Feed view, not
      // GroupChatView — re-enter the group through the SPA's own nav
      // instead: back to Inbox, into Groups, open the now-complete group.
      await page.getByRole('button', { name: 'Go back' }).click()
      await page.getByRole('tab', { name: 'Groups' }).click()
      await page.getByText(groupName).click()
      await expect(page.getByText('Papers in this conversation')).toBeVisible({ timeout: 15_000 })
      await page.screenshot({ path: shot('02_synthesis_complete'), fullPage: true })
    } else {
      // Still generating after 90s — acceptable for this smoke test
      // (mirrors R9-02's tolerance for a pending Archivist reply). With
      // the retry-on-404 fix the UI must be showing either the pending
      // "Synthesizing…" hint or (if the worker finished in the last
      // moments) the synthesis content — never the failure card.
      await expect(page.getByRole('button', { name: 'Go back' })).toBeVisible()
      await expect(
        page.getByText('Synthesizing…').or(page.getByText('Papers in this conversation')).first()
      ).toBeVisible()
      await expect(page.getByText('Synthesis failed to load')).not.toBeVisible()
      await page.screenshot({ path: shot('02_synthesis_pending'), fullPage: true })
    }

    // Cleanup — delete the two test papers so the corpus doesn't
    // accumulate junk. There's no DELETE endpoint for group-chat
    // syntheses, so that artifact is left behind (same as this suite's
    // other e2e specs leave their created rows).
    //
    // DELETE is CSRF-protected even under AUTH_PROVIDER=none
    // (api/csrf.py), so the double-submit cookie has to be echoed back as
    // an X-CSRF-Token header explicitly — context.request doesn't do this
    // automatically the way the app's own fetch wrapper (lib/api.ts
    // request()) does. Round9's cleanup omits this and its deletes 403
    // silently (wrapped in .catch); doing it properly here so this spec
    // doesn't leave papers behind on every run.
    const csrfCookie = (await context.cookies()).find(c => c.name === 'ficino_csrf')
    const csrfHeaders = csrfCookie ? { 'X-CSRF-Token': csrfCookie.value } : {}
    await context.request.delete(`${BASE}/api/papers/${paperA.id}`, { headers: csrfHeaders, ignoreHTTPSErrors: true }).catch(() => {})
    await context.request.delete(`${BASE}/api/papers/${paperB.id}`, { headers: csrfHeaders, ignoreHTTPSErrors: true }).catch(() => {})
  })
})
