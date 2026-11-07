/**
 * Seeds one real, fully ingested paper for the full suite (plan 06).
 *
 * The fixture paper from ensureFeed.ts has no chunks, so on a fresh database the
 * archivist has nothing to retrieve and R9-02's `sources.length > 0` fails.
 * This uploads the server's 3-page sample PDF through the API (as the
 * AUTH_PROVIDER=none stub user, into the Default workspace) and waits until
 * ingestion completes. It needs real providers (`scripts/e2e-stack.sh up
 * --ollama`); globalSetup calls it only when E2E_SEED_SAMPLE_PDF=1.
 *
 * Idempotent: a paper named e2e-sample.pdf that is already `complete` is reused.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { request } from '@playwright/test'

export const SAMPLE_FILENAME = 'e2e-sample.pdf'
const DEFAULT_PDF = resolve(__dirname, '..', '..', '..', 'server', 'test', 'fixtures', 'sample.pdf')
const POLL_MS = 2_000

interface PaperJson {
  id: string
  filename: string
  status: string
  error_message?: string | null
}

/** Uploads the sample PDF (unless already ingested) and resolves with its paper id once `complete`. */
export async function seedSamplePaper(
  baseUrl: string,
  opts: { pdfPath?: string; timeoutMs?: number } = {},
): Promise<string> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const timeoutMs = opts.timeoutMs ?? 300_000
  const ctx = await request.newContext({ ignoreHTTPSErrors: true })
  try {
    // A GET sets the double-submit CSRF cookie that the upload must echo.
    const list = await ctx.get(`${base}api/papers`)
    if (!list.ok()) throw new Error(`seedSamplePaper: GET api/papers -> ${list.status()} ${await list.text()}`)
    const existing = ((await list.json()) as PaperJson[]).find(
      (p) => p.filename === SAMPLE_FILENAME && p.status === 'complete',
    )
    if (existing) return existing.id

    const csrf = (await ctx.storageState()).cookies.find((c) => c.name === 'ficino_csrf')?.value
    if (!csrf) throw new Error('seedSamplePaper: no ficino_csrf cookie after GET api/papers')

    const upload = await ctx.post(`${base}api/papers`, {
      headers: { 'X-CSRF-Token': csrf },
      multipart: {
        file: {
          name: SAMPLE_FILENAME,
          mimeType: 'application/pdf',
          buffer: readFileSync(opts.pdfPath ?? DEFAULT_PDF),
        },
      },
    })
    if (!upload.ok()) throw new Error(`seedSamplePaper: upload -> ${upload.status()} ${await upload.text()}`)
    const { id } = (await upload.json()) as PaperJson

    const deadline = Date.now() + timeoutMs
    for (;;) {
      const res = await ctx.get(`${base}api/papers/${id}`)
      if (!res.ok()) throw new Error(`seedSamplePaper: GET api/papers/${id} -> ${res.status()}`)
      const paper = (await res.json()) as PaperJson
      if (paper.status === 'complete') return id
      if (paper.status === 'error') {
        throw new Error(`seedSamplePaper: ingestion failed: ${paper.error_message ?? 'no error message'}`)
      }
      if (Date.now() + POLL_MS > deadline) {
        throw new Error(`seedSamplePaper: paper still '${paper.status}' after ${timeoutMs} ms`)
      }
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
  } finally {
    await ctx.dispose()
  }
}
