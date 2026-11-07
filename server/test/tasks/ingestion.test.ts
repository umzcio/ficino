import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mupdf from 'mupdf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { createSql } from '../../src/db/sql.js';
import { CONTEXT_SYSTEM_PROMPT } from '../../src/ingest/contextualize.js';
import { makeJobContext } from '../../src/jobs/context.js';
import { createBoss, JobQueue } from '../../src/jobs/queue.js';
import { logger } from '../../src/logger.js';
import { LocalStorage } from '../../src/storage/local.js';
import { processPaper } from '../../src/tasks/ingestion.js';
import type { WorkerDeps } from '../../src/worker/handlers.js';
import { HANDLERS } from '../../src/worker/handlers.js';
import { startWorker, type RunningWorker } from '../../src/worker/main.js';
import { createScratchDb, resetDb, seedUsers, testSql, type Seeded } from '../helpers/db.js';
import { fakeProviders, type FakeProviderOpts } from '../helpers/fakeProviders.js';
import { testQueue } from '../helpers/queue.js';

const sql = testSql();
const SAMPLE = new Uint8Array(readFileSync(new URL('../fixtures/sample.pdf', import.meta.url)));
const OLLAMA = 'http://fake-ollama:11434';

let dir: string;
let config: Config;
let storage: LocalStorage;
let s: Seeded;

beforeEach(async () => {
  await resetDb(sql);
  s = await seedUsers(sql);
  dir = await mkdtemp(join(tmpdir(), 'ficino-ingest-'));
  config = loadConfig({
    OLLAMA_BASE_URL: OLLAMA,
    UPLOAD_DIR: join(dir, 'uploads'),
    FIGURES_DIR: join(dir, 'figures'),
    MEDIA_DIR: join(dir, 'media'),
  });
  storage = new LocalStorage(config, Buffer.from('k'.repeat(32)));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---- helpers ---------------------------------------------------------------------------------------------

const METADATA = {
  title: 'Attention Around the Table',
  authors: ['Ada Reader', 'Ben Notes'],
  year: 2024,
  doi: '10.1234/rg.2024',
  tags: ['reading groups', 'discussion', 'education', 'a fourth tag'],
};

const FIGURE = {
  bbox: [0.1, 0.5, 0.6, 0.8],
  type: 'chart_line',
  caption: 'Fig. 1. Share of turns.',
  figure_number: '1',
  data_claim: 'Attention clusters on dense paragraphs. Quiet members return to them.',
  referenced_paragraph: 'As Fig. 1 shows...',
  confidence: 0.9,
};

const VISION_PAGE =
  'Reading groups are a common way for small teams to keep up with a field. This page was read by a vision ' +
  'model because the PDF has no text layer. Attention clusters around a few dense paragraphs, and quiet members ' +
  'often return to those paragraphs later in writing, which suggests simple changes for organizers.';

function fakes(opts: FakeProviderOpts = {}) {
  return fakeProviders({
    chat: (_b, info) => {
      if (info.purpose === 'metadata') return JSON.stringify(METADATA);
      if (info.purpose === 'vision') return VISION_PAGE;
      return 'A situating sentence.';
    },
    detect: (page) => (page === 2 ? [FIGURE] : []),
    ...opts,
  });
}

function depsWith(providers: WorkerDeps['providers']): WorkerDeps {
  return { sql, config, env: {}, logger, storage, queue: testQueue(), providers, rng: Math.random };
}

function ctxFor(softLimitMs = 600_000) {
  const ac = new AbortController();
  const ctx = makeJobContext(
    { id: randomUUID(), name: 'process_paper', retryCount: 0, signal: ac.signal },
    sql,
    logger,
    softLimitMs,
    2,
  );
  return { ctx, ac };
}

async function newPaper(userId: string, bytes: Uint8Array, corpusId: string | null = null): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status)
    VALUES (${id}, ${userId}, ${corpusId}, 'p.pdf', ${storage.pdfPath(id)}, 'pending')`;
  await storage.savePdf(id, bytes);
  return id;
}

async function setSettings(userId: string, settings: Record<string, unknown>) {
  await sql`INSERT INTO user_settings (user_id, settings) VALUES (${userId}, ${sql.json(settings as never)})`;
}

async function paper(id: string) {
  const [r] = await sql`SELECT * FROM papers WHERE id = ${id}`;
  return r!;
}

async function sentJobs(name: string) {
  const rows = await sql`SELECT data FROM pgboss.job WHERE name = ${name}`;
  return rows.map((r) => r.data as Record<string, unknown>);
}

/** A PDF built with MuPDF: each page is either lines of Helvetica text or a single filled rectangle (no text layer). */
function buildPdf(pages: Array<string[] | 'rect'>): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
    for (const p of pages) {
      const contents =
        p === 'rect'
          ? '0.2 0.3 0.6 rg 72 200 468 400 re f'
          : `BT /F1 10 Tf 14 TL 72 740 Td ${p.map((l) => `(${l.replace(/[()\\]/g, '')}) '`).join(' ')} ET`;
      const resources = p === 'rect' ? {} : { Font: { F1: font } };
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, contents));
    }
    return doc.saveToBuffer('compress').asUint8Array().slice();
  } finally {
    doc.destroy();
  }
}

/** Two text pages whose every line carries `marker`, so a provider call can be traced to its paper. */
function markedPdf(marker: string): Uint8Array {
  const page = (n: number) =>
    Array.from(
      { length: 30 },
      (_, i) => `${marker} line ${n}.${i}: group ${i % 9} discussed passage ${i * 7 + n} and noted point ${i * 3}.`,
    );
  return buildPdf([page(1), page(2)]);
}

// ---- tests -------------------------------------------------------------------------------------------------

describe('processPaper', () => {
  it('happy path: extracts, tags, chunks, embeds, stores a figure, completes and fans out', async () => {
    const id = await newPaper(s.user_a, SAMPLE, s.workspace_a);
    const f = fakes();
    const { ctx } = ctxFor();
    const steps: string[] = [];
    const progress = ctx.progress.bind(ctx);
    ctx.progress = async (meta) => {
      steps.push(String(meta.step));
      expect(meta).toEqual({ step: meta.step, paper_id: id });
      await progress(meta);
    };

    const result = await processPaper({ paper_id: id }, ctx, depsWith(f.deps));

    const p = await paper(id);
    expect(p.status).toBe('complete');
    expect(p.extraction_path).toBe('pymupdf_clean');
    expect(p.processed_at).not.toBeNull();
    expect(p.error_message).toBeNull();
    expect([p.title, p.authors, p.year, p.doi]).toEqual([METADATA.title, METADATA.authors, 2024, METADATA.doi]);
    expect(steps).toEqual([
      'extracting',
      'quality_checking',
      'metadata',
      'chunking',
      'contextualizing',
      'embedding',
      'extracting_figures',
    ]);

    const chunks = await sql`
      SELECT embedding IS NOT NULL AS has_emb, search_vector IS NOT NULL AS has_sv, metadata->>'embed_model' AS m,
             contextual_prefix, user_id::text AS u
      FROM chunks WHERE paper_id = ${id}`;
    expect(chunks.length).toBeGreaterThan(0);
    expect(p.chunk_count).toBe(chunks.length);
    expect(chunks.every((c) => c.has_emb && c.has_sv && c.u === s.user_a)).toBe(true);
    expect(new Set(chunks.map((c) => c.m))).toEqual(new Set(['ollama:qwen3-embedding:latest@1024']));
    expect(chunks.every((c) => c.contextual_prefix === null)).toBe(true); // context_provider defaults to none

    const tags = await sql`
      SELECT t.name FROM paper_tags pt JOIN tags t ON t.id = pt.tag_id
      WHERE pt.paper_id = ${id} AND t.user_id = ${s.user_a} ORDER BY t.name`;
    expect(tags.map((t) => t.name)).toEqual(['discussion', 'education', 'reading groups']);

    const figs = await sql`SELECT page_number, image_path, figure_index, description, claim_summary FROM figures WHERE paper_id = ${id}`;
    const png = join(config.figuresDir, id, 'fig_p2_0.png');
    expect(figs.map((r) => [r.page_number, r.image_path, r.figure_index])).toEqual([[2, png, 0]]);
    expect(figs[0]!.description).toBe(FIGURE.data_claim);
    expect(figs[0]!.claim_summary).toBe('Attention clusters on dense paragraphs');
    expect(existsSync(png)).toBe(true);
    expect(p.figure_count).toBe(1);

    const [jp] = await sql`SELECT meta FROM job_progress WHERE job_id = ${ctx.jobId}`;
    expect(jp!.meta).toEqual({ step: 'extracting_figures', paper_id: id });

    expect(await sentJobs('check_contradictions')).toEqual([{ paper_id: id }]);
    expect(await sentJobs('generate_feed')).toEqual([]);

    expect(result).toEqual({
      status: 'complete',
      paper_id: id,
      extraction_path: 'pymupdf_clean',
      chunk_count: chunks.length,
      figure_count: 1,
    });
    // Without prefixes the embedded text is the chunk content; nothing went to Anthropic.
    const embedded = f.calls.filter((c) => c.kind === 'ollama-embed').flatMap((c) => (c.body as { input: string[] }).input);
    expect(embedded).toHaveLength(chunks.length);
    expect(f.calls.filter((c) => c.kind === 'anthropic')).toEqual([]);
  });

  it('auto_generate_on_upload with a corpus sends generate_feed {corpus_id, user_id}', async () => {
    await setSettings(s.user_a, { auto_generate_on_upload: true });
    const id = await newPaper(s.user_a, SAMPLE, s.workspace_a);
    await processPaper({ paper_id: id }, ctxFor().ctx, depsWith(fakes().deps));
    expect(await sentJobs('generate_feed')).toEqual([{ corpus_id: s.workspace_a, user_id: s.user_a }]);
    expect(await sentJobs('check_contradictions')).toEqual([{ paper_id: id }]);
  });

  it('auto_generate_on_upload without a corpus sends no generate_feed', async () => {
    await setSettings(s.user_a, { auto_generate_on_upload: true });
    const id = await newPaper(s.user_a, SAMPLE, null);
    await processPaper({ paper_id: id }, ctxFor().ctx, depsWith(fakes().deps));
    expect(await sentJobs('generate_feed')).toEqual([]);
  });

  it('prefixes from the contextualizer are stored and prepended (stripped) to the embedded text', async () => {
    await setSettings(s.user_a, { context_provider: 'ollama' });
    const id = await newPaper(s.user_a, SAMPLE);
    const f = fakes({ chat: (_b, i) => (i.purpose === 'metadata' ? '{}' : '  Situating sentence.  ') });
    await processPaper({ paper_id: id }, ctxFor().ctx, depsWith(f.deps));
    const rows = await sql`SELECT content, contextual_prefix FROM chunks WHERE paper_id = ${id} ORDER BY chunk_index`;
    expect(rows.every((r) => r.contextual_prefix === 'Situating sentence.')).toBe(true);
    const embedded = f.calls.filter((c) => c.kind === 'ollama-embed').flatMap((c) => (c.body as { input: string[] }).input);
    expect(embedded).toEqual(rows.map((r) => `Situating sentence.\n\n${String(r.content)}`.trim()));
  });

  // Security review: one provider call per chunk is capped per paper (CONTEXT_MAX_CHUNKS).
  it('a paper over CONTEXT_MAX_CHUNKS is stored without prefixes and makes no contextualizer calls', async () => {
    config = loadConfig({
      OLLAMA_BASE_URL: OLLAMA,
      UPLOAD_DIR: join(dir, 'uploads'),
      FIGURES_DIR: join(dir, 'figures'),
      MEDIA_DIR: join(dir, 'media'),
      CONTEXT_MAX_CHUNKS: '2',
    });
    await setSettings(s.user_a, { context_provider: 'ollama', chunk_max_tokens: 100 });
    const id = await newPaper(s.user_a, markedPdf('CAP'));
    const f = fakes();
    const r = await processPaper({ paper_id: id }, ctxFor().ctx, depsWith(f.deps));
    expect(r.status).toBe('complete');
    expect(Number(r.chunk_count)).toBeGreaterThan(2);
    const isContext = (c: (typeof f.calls)[number]) =>
      c.kind === 'ollama-chat' && JSON.stringify(c.body).includes(CONTEXT_SYSTEM_PROMPT);
    expect(f.calls.filter(isContext)).toEqual([]);
    const rows = await sql`SELECT contextual_prefix FROM chunks WHERE paper_id = ${id}`;
    expect(rows).toHaveLength(Number(r.chunk_count));
    expect(rows.every((row) => row.contextual_prefix === null)).toBe(true);
  });

  // Port of worker/tests/test_auto_tagging.py: a failing tag insert must not cost the paper.
  it('a tag insert failure is logged and swallowed; the paper still completes', async () => {
    const id = await newPaper(s.user_a, SAMPLE);
    // Two tags that lowercase to the same name make the one-statement upsert hit the same row twice (a DB error).
    const f = fakes({
      chat: (_b, i) => (i.purpose === 'metadata' ? JSON.stringify({ ...METADATA, tags: ['nlp', 'NLP'] }) : 'x'),
    });
    const { ctx } = ctxFor();
    const errors: unknown[] = [];
    const child = ctx.logger.child({});
    vi.spyOn(child, 'error').mockImplementation(((obj: unknown, msg?: string) => {
      errors.push([obj, msg]);
    }) as never);
    ctx.logger = { child: () => child } as never;
    const result = await processPaper({ paper_id: id }, ctx, depsWith(f.deps));
    expect(result.status).toBe('complete');
    expect((await paper(id)).status).toBe('complete');
    const [n] = await sql`SELECT count(*)::int AS n FROM paper_tags WHERE paper_id = ${id}`;
    expect(n!.n).toBe(0);
    expect(errors).toContainEqual([
      expect.objectContaining({ tags: ['nlp', 'nlp'], error_type: 'PostgresError' }),
      'auto_tag_failed',
    ]);
  });

  it('quality fallback: a PDF with no text layer is re-read by vision, one call per page', async () => {
    const id = await newPaper(s.user_a, buildPdf(['rect', 'rect']));
    const f = fakes();
    const result = await processPaper({ paper_id: id }, ctxFor().ctx, depsWith(f.deps));
    const p = await paper(id);
    expect(p.status).toBe('complete');
    expect(p.extraction_path).toBe('vision_fallback');
    expect(result.extraction_path).toBe('vision_fallback');
    const vision = f.calls.filter(
      (c) => c.kind === 'ollama-chat' && JSON.stringify(c.body).includes('You are an academic paper text extractor'),
    );
    expect(vision.map((c) => (c.body as { messages: Array<{ content: string }> }).messages[1]!.content)).toEqual([
      'Extract all text from page 1 as structured markdown.',
      'Extract all text from page 2 as structured markdown.',
    ]);
    expect(p.chunk_count).toBeGreaterThan(0);
  });

  it('extraction_mode pymupdf skips the quality check: pymupdf_forced even for an empty text layer', async () => {
    await setSettings(s.user_a, { extraction_mode: 'pymupdf' });
    const id = await newPaper(s.user_a, buildPdf(['rect']));
    const f = fakes();
    const result = await processPaper({ paper_id: id }, ctxFor().ctx, depsWith(f.deps));
    expect(result).toMatchObject({ status: 'complete', extraction_path: 'pymupdf_forced', chunk_count: 0 });
    expect(f.calls.some((c) => JSON.stringify(c.body).includes('academic paper text extractor'))).toBe(false);
    expect(f.calls.some((c) => c.kind === 'ollama-embed')).toBe(false);
  });

  it('extraction_mode vision: vision_forced when available, pymupdf_clean when not', async () => {
    await setSettings(s.user_a, { extraction_mode: 'vision' });
    const a = await newPaper(s.user_a, SAMPLE);
    expect((await processPaper({ paper_id: a }, ctxFor().ctx, depsWith(fakes().deps))).extraction_path).toBe(
      'vision_forced',
    );
    // llm_provider api without a key: vision falls back to llm_provider and is unavailable.
    await setSettings(s.user_b, { extraction_mode: 'vision', llm_provider: 'api' });
    const b = await newPaper(s.user_b, SAMPLE);
    const r = await processPaper({ paper_id: b }, ctxFor().ctx, depsWith(fakes().deps));
    expect(r.extraction_path).toBe('pymupdf_clean');
  });

  // Review Focus 3: embedding mismatches are loud, final, and store nothing.
  it('a wrong-dimension embedding marks the paper error without chunks and returns (no retry)', async () => {
    const id = await newPaper(s.user_a, SAMPLE);
    const result = await processPaper({ paper_id: id }, ctxFor().ctx, depsWith(fakes({ dim: 768 }).deps));
    const p = await paper(id);
    expect(p.status).toBe('error');
    expect(p.error_message).toMatch(/^No embedding provider available: embed_texts dim mismatch/);
    expect(result).toEqual({ status: 'error', paper_id: id, error: p.error_message });
    const [n] = await sql`SELECT count(*)::int AS n FROM chunks WHERE paper_id = ${id}`;
    expect(n!.n).toBe(0);
    expect(await sentJobs('check_contradictions')).toEqual([]);
  });

  // Review Focus 4: unreadable PDFs fail (and so retry), never hang; a vanished paper is skipped.
  it('junk after %PDF- throws and leaves the paper error with a message', async () => {
    const id = await newPaper(s.user_a, new TextEncoder().encode('%PDF-1.7\n\u0000\u0001garbage not a pdf at all'));
    await expect(processPaper({ paper_id: id }, ctxFor().ctx, depsWith(fakes().deps))).rejects.toThrow();
    const p = await paper(id);
    expect(p.status).toBe('error');
    expect(String(p.error_message)).not.toBe('');
  });

  it('a missing PDF file throws and leaves the paper error', async () => {
    const id = await newPaper(s.user_a, SAMPLE);
    await storage.deletePdf(id);
    await expect(processPaper({ paper_id: id }, ctxFor().ctx, depsWith(fakes().deps))).rejects.toThrow(/ENOENT/);
    expect((await paper(id)).status).toBe('error');
  });

  // Security review: bounded PDF work.
  it('a PDF over MAX_PDF_PAGES is rejected before any extraction or provider call', async () => {
    const id = await newPaper(s.user_a, SAMPLE);
    const f = fakes();
    const deps = { ...depsWith(f.deps), config: { ...config, maxPdfPages: 2 } };
    await expect(processPaper({ paper_id: id }, ctxFor().ctx, deps)).rejects.toThrow('PDF has 3 pages; the limit is 2');
    const p = await paper(id);
    expect(p.status).toBe('error');
    expect(p.error_message).toBe('PDF has 3 pages; the limit is 2');
    expect(f.calls).toEqual([]);
  });

  it('figure detection sees at most FIGURE_DETECT_MAX_PAGES pages', async () => {
    const id = await newPaper(s.user_a, SAMPLE);
    const f = fakes(); // the one figure is on page 2
    const deps = { ...depsWith(f.deps), config: { ...config, figureDetectMaxPages: 1 } };
    const r = await processPaper({ paper_id: id }, ctxFor().ctx, deps);
    expect(r).toMatchObject({ status: 'complete', figure_count: 0 });
    const detectCalls = f.calls.filter((c) => JSON.stringify(c.body).includes('This is page'));
    expect(detectCalls).toHaveLength(1);
    expect(JSON.stringify(detectCalls[0]!.body)).toContain('This is page 1 of');
  });

  it('the job checkpoint runs before every page of the text pass, the page-text pass and figure detection', async () => {
    const id = await newPaper(s.user_a, SAMPLE);
    const { ctx } = ctxFor();
    let calls = 0;
    const checkpoint = ctx.checkpoint;
    ctx.checkpoint = () => {
      calls++;
      checkpoint();
    };
    expect(await processPaper({ paper_id: id }, ctx, depsWith(fakes().deps))).toMatchObject({ status: 'complete' });
    expect(calls).toBe(9); // 3 pages x (markdown, page text, detection)
  });

  it('a checkpoint that throws during text extraction stops the paper before any provider call', async () => {
    const id = await newPaper(s.user_a, SAMPLE);
    const f = fakes();
    const { ctx } = ctxFor();
    const stop = new Error('time is up');
    ctx.checkpoint = () => {
      throw stop;
    };
    await expect(processPaper({ paper_id: id }, ctx, depsWith(f.deps))).rejects.toBe(stop);
    expect((await paper(id)).error_message).toBe('time is up');
    expect(f.calls).toEqual([]);
  });

  it('a deleted paper row returns skipped and calls no provider', async () => {
    const id = await newPaper(s.user_a, SAMPLE);
    await sql`DELETE FROM papers WHERE id = ${id}`;
    const f = fakes();
    expect(await processPaper({ paper_id: id }, ctxFor().ctx, depsWith(f.deps))).toEqual({
      status: 'skipped',
      paper_id: id,
      reason: 'paper not found',
    });
    expect(await processPaper({ paper_id: 'not-a-uuid' }, ctxFor().ctx, depsWith(f.deps))).toEqual({
      status: 'skipped',
      paper_id: 'not-a-uuid',
      reason: 'paper not found',
    });
    expect(f.calls).toEqual([]);
  });

  // Review Focus 5: an over-time job stops spending.
  // The soft limit is final (security review): a rerun would spend the same budget again and time out again.
  it('a hung provider is cut off by the soft limit: returns fast with status error (no retry), no calls after the abort', async () => {
    const id = await newPaper(s.user_a, SAMPLE);
    const f = fakes({ chat: () => new Promise<string>(() => {}) });
    const { ctx } = ctxFor(1000);
    let callsAtAbort = -1;
    ctx.signal.addEventListener('abort', () => (callsAtAbort = f.calls.length), { once: true });
    const t0 = Date.now();
    const r = await processPaper({ paper_id: id }, ctx, depsWith(f.deps));
    expect(Date.now() - t0).toBeLessThan(3000);
    const p = await paper(id);
    expect(p.status).toBe('error');
    expect(String(p.error_message)).toMatch(/abort|timeout/i);
    expect(r).toEqual({ status: 'error', paper_id: id, error: String(p.error_message) });
    expect(callsAtAbort).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(f.calls).toHaveLength(callsAtAbort);
  });

  it('a pg-boss abort (not the soft limit) still rejects, so the job is retried', async () => {
    const id = await newPaper(s.user_a, SAMPLE);
    const f = fakes({ chat: () => new Promise<string>(() => {}) });
    const { ctx, ac } = ctxFor();
    setTimeout(() => ac.abort(new Error('worker stopping')), 200);
    await expect(processPaper({ paper_id: id }, ctx, depsWith(f.deps))).rejects.toBeDefined();
    expect((await paper(id)).status).toBe('error');
  });

  // Review Focus 1: concurrent jobs for different users never cross keys.
  it('two users’ jobs run concurrently and every Anthropic call uses its own paper owner’s key', async () => {
    const base = { llm_provider: 'api', figure_detect_provider: 'anthropic' };
    await setSettings(s.user_a, { ...base, anthropic_api_key: 'sk-A' });
    await setSettings(s.user_b, { ...base, anthropic_api_key: 'sk-B' });
    const pa = await newPaper(s.user_a, markedPdf('ALPHA'));
    const pb = await newPaper(s.user_b, markedPdf('BRAVO'));
    const f = fakes({ delayMs: 20 });
    const deps = depsWith(f.deps);

    const [ra, rb] = await Promise.all([
      processPaper({ paper_id: pa }, ctxFor().ctx, deps),
      processPaper({ paper_id: pb }, ctxFor().ctx, deps),
    ]);
    expect(ra.status).toBe('complete');
    expect(rb.status).toBe('complete');
    expect(ra.figure_count).toBe(1);
    expect(rb.figure_count).toBe(1);

    const anthropic = f.calls.filter((c) => c.kind === 'anthropic');
    const owner = (c: (typeof anthropic)[number]) => {
      const text = JSON.stringify(c.body);
      const a = text.includes('ALPHA');
      const b = text.includes('BRAVO');
      expect(a !== b).toBe(true); // every call is traceable to exactly one paper
      return a ? 'A' : 'B';
    };
    const forA = anthropic.filter((c) => owner(c) === 'A');
    const forB = anthropic.filter((c) => owner(c) === 'B');
    // metadata + one detector call per page, for each paper
    expect(forA).toHaveLength(3);
    expect(forB).toHaveLength(3);
    expect(forA.every((c) => c.apiKey === 'sk-A')).toBe(true);
    expect(forB.every((c) => c.apiKey === 'sk-B')).toBe(true);
    // The calls really interleaved.
    const order = anthropic.map(owner).join('');
    expect(order).not.toMatch(/^A+B+$|^B+A+$/);
  });
});

describe('process_paper through a real worker', () => {
  let worker: RunningWorker | undefined;
  let drop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await worker?.close();
    await drop?.();
    worker = drop = undefined;
  });

  it('is registered in HANDLERS', () => {
    expect(typeof HANDLERS.process_paper).toBe('function');
  });

  it('junk PDF bytes: the job fails after 3 attempts and the paper is error', async () => {
    const scratch = await createScratchDb();
    drop = scratch.drop;
    const env = {
      DATABASE_URL: scratch.url,
      AUTH_PROVIDER: 'none',
      ENVIRONMENT: 'development',
      LOG_LEVEL: 'silent',
      OLLAMA_BASE_URL: OLLAMA,
      UPLOAD_DIR: join(dir, 'w-uploads'),
      FIGURES_DIR: join(dir, 'w-figures'),
      MEDIA_DIR: join(dir, 'w-media'),
    };
    const f = fakes();
    worker = await startWorker(env, {
      providers: f.deps,
      queueOverrides: { process_paper: { retryDelay: 0 } },
    });

    const probe = createSql(scratch.url, { max: 2 });
    const boss = createBoss(scratch.url, { max: 2, supervise: false, schedule: false });
    boss.on('error', () => undefined);
    try {
      const userId = randomUUID();
      const paperId = randomUUID();
      await probe`INSERT INTO users (id, email) VALUES (${userId}, 'w@ficino.dev')`;
      await probe`
        INSERT INTO papers (id, user_id, filename, file_path, status)
        VALUES (${paperId}, ${userId}, 'j.pdf', 'j.pdf', 'pending')`;
      await mkdir(env.UPLOAD_DIR, { recursive: true });
      await writeFile(join(env.UPLOAD_DIR, `${paperId}.pdf`), '%PDF-1.4\nthis is not really a pdf');

      await boss.start();
      const queue = new JobQueue(boss, probe);
      const jobId = await queue.send('process_paper', { paper_id: paperId });
      await vi.waitFor(
        async () => {
          expect((await queue.getJobState(jobId)).state).toBe('failed');
        },
        { timeout: 45_000, interval: 250 },
      );
      const job = await boss.getJobById('process_paper', jobId);
      expect(job!.retryCount).toBe(2);
      const [p] = await probe`SELECT status, error_message FROM papers WHERE id = ${paperId}`;
      expect(p!.status).toBe('error');
      expect(String(p!.error_message)).not.toBe('');
      expect(f.calls).toEqual([]);
    } finally {
      await boss.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
      await probe.end();
    }
  }, 60_000);

  it('a soft-limit timeout completes the job without a retry and leaves the paper error', async () => {
    const scratch = await createScratchDb();
    drop = scratch.drop;
    const env = {
      DATABASE_URL: scratch.url,
      AUTH_PROVIDER: 'none',
      ENVIRONMENT: 'development',
      LOG_LEVEL: 'silent',
      OLLAMA_BASE_URL: OLLAMA,
      UPLOAD_DIR: join(dir, 'w-uploads'),
      FIGURES_DIR: join(dir, 'w-figures'),
      MEDIA_DIR: join(dir, 'w-media'),
    };
    const f = fakes({ chat: () => new Promise<string>(() => {}) });
    worker = await startWorker(env, {
      providers: f.deps,
      softLimitMs: 500,
      queueOverrides: { process_paper: { retryDelay: 0 } },
    });

    const probe = createSql(scratch.url, { max: 2 });
    const boss = createBoss(scratch.url, { max: 2, supervise: false, schedule: false });
    boss.on('error', () => undefined);
    try {
      const userId = randomUUID();
      const paperId = randomUUID();
      await probe`INSERT INTO users (id, email) VALUES (${userId}, 'w@ficino.dev')`;
      await probe`
        INSERT INTO papers (id, user_id, filename, file_path, status)
        VALUES (${paperId}, ${userId}, 't.pdf', 't.pdf', 'pending')`;
      await mkdir(env.UPLOAD_DIR, { recursive: true });
      await writeFile(join(env.UPLOAD_DIR, `${paperId}.pdf`), SAMPLE);

      await boss.start();
      const queue = new JobQueue(boss, probe);
      const jobId = await queue.send('process_paper', { paper_id: paperId });
      await vi.waitFor(
        async () => {
          expect((await queue.getJobState(jobId)).state).toBe('completed');
        },
        { timeout: 20_000, interval: 100 },
      );
      const job = await boss.getJobById('process_paper', jobId);
      expect(job!.retryCount).toBe(0);
      const [p] = await probe`SELECT status, error_message FROM papers WHERE id = ${paperId}`;
      expect(p!.status).toBe('error');
      expect(String(p!.error_message)).toMatch(/abort|timeout/i);
      // One attempt: the metadata call that hung, and nothing after it.
      expect(f.calls).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 300));
      expect(f.calls).toHaveLength(1);
    } finally {
      await boss.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
      await probe.end();
    }
  }, 60_000);
});
