import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CSRF_TEST_TOKEN, client, testApp, testStorageDirs } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID, type Seeded } from '../helpers/db.js';
import { testQueue } from '../helpers/queue.js';
import { resolveSigningKey, verifyToken } from '../../src/shared/signedUrl.js';
import pino from 'pino';
import { createApp, type AppDeps } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { LocalStorage } from '../../src/storage/local.js';

const sql = testSql();
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});
const user = (id: string) => ({ id, email: `${id}@ficino.dev`, display_name: 'U' });
const as = (id: string, config?: Partial<Config>) => testApp({ user: user(id), config });
const PDF = new TextEncoder().encode('%PDF-1.4 tiny');

type App = ReturnType<typeof testApp>;
const csrfHeaders = (extra: Record<string, string> = {}) => ({
  cookie: `ficino_csrf=${CSRF_TEST_TOKEN}`,
  'x-csrf-token': CSRF_TEST_TOKEN,
  ...extra,
});

/** Multipart upload straight through app.request (the shared client only sends JSON). */
function upload(
  app: App,
  o: { filename?: string; bytes?: Uint8Array; query?: string; headers?: Record<string, string>; field?: string } = {},
) {
  const form = new FormData();
  form.set(o.field ?? 'file', new File([(o.bytes ?? PDF) as BlobPart], o.filename ?? 'test.pdf', { type: 'application/pdf' }));
  return app.request(`/papers${o.query ?? ''}`, { method: 'POST', body: form, headers: csrfHeaders(o.headers) });
}

describe('papers: list / get', () => {
  it('test_list_papers_returns_only_own_papers', async () => {
    const a = await (await client(as(USER_A_ID)).get('/papers')).json();
    expect(a.map((p: { id: string }) => p.id)).toContain(seeded.paper_a);
    expect(a.map((p: { id: string }) => p.id)).not.toContain(seeded.paper_b);
    const b = await (await client(as(USER_B_ID)).get('/papers')).json();
    expect(b.map((p: { id: string }) => p.id)).toContain(seeded.paper_b);
    expect(b.map((p: { id: string }) => p.id)).not.toContain(seeded.paper_a);
  });

  it('returns every Paper key, tags aggregated, and filters by workspace', async () => {
    const [{ id: tagId }] = await sql`INSERT INTO tags (user_id, name) VALUES (${USER_A_ID}, 'x') RETURNING id`;
    await sql`INSERT INTO paper_tags (paper_id, tag_id) VALUES (${seeded.paper_a}, ${tagId})`;
    const list = await (await client(as(USER_A_ID)).get(`/papers?workspace_id=${seeded.workspace_a}`)).json();
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0])).toEqual([
      'id', 'user_id', 'corpus_id', 'title', 'authors', 'year', 'doi', 'filename', 'status', 'extraction_path',
      'error_message', 'chunk_count', 'figure_count', 'tags', 'uploaded_at', 'processed_at',
    ]);
    expect(list[0].authors).toEqual([]);
    expect(list[0].tags).toEqual([{ id: String(tagId), name: 'x' }]);
    expect(list[0].uploaded_at).toMatch(/Z$/);
    expect(list[0].processed_at).toBeNull();
    const other = await (await client(as(USER_A_ID)).get(`/papers?workspace_id=${seeded.workspace_b}`)).json();
    expect(other).toEqual([]);
  });

  it('get returns the paper with tags []', async () => {
    const r = await client(as(USER_A_ID)).get(`/papers/${seeded.paper_a}`);
    expect(r.status).toBe(200);
    expect((await r.json()).tags).toEqual([]);
  });

  it('test_get_paper_rejects_cross_user_read', async () => {
    const r = await client(as(USER_B_ID)).get(`/papers/${seeded.paper_a}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Paper not found' });
  });
});

describe('papers: figures list', () => {
  it('test_get_paper_figures_rejects_cross_user_read (empty list, no 404)', async () => {
    const r = await client(as(USER_B_ID)).get(`/papers/${seeded.paper_a}/figures`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  it('test_figures_image_url_hydrated_off_loop: each url is signed for its own figure', async () => {
    const ids = [randomUUID(), randomUUID()];
    for (const [i, id] of ids.entries()) {
      await sql`INSERT INTO figures (id, paper_id, page_number, image_path, extraction_type, description, claim_summary, figure_index)
                VALUES (${id}, ${seeded.paper_a}, 1, ${`/x/${id}.png`}, 'image', 'd', 'c', ${i})`;
    }
    const body = await (await client(as(USER_A_ID)).get(`/papers/${seeded.paper_a}/figures`)).json();
    expect(body.map((f: { id: string }) => f.id)).toEqual(ids);
    expect(Object.keys(body[0])).toEqual([
      'id', 'page_number', 'image_url', 'extraction_type', 'description', 'claim_summary', 'figure_index',
    ]);
    const key = resolveSigningKey({ DATABASE_URL: process.env.DATABASE_URL });
    for (const f of body) {
      const u = new URL(f.image_url, 'http://x');
      expect(u.pathname).toBe(`/figures/${seeded.paper_a}/${f.id}`);
      expect(verifyToken(key, f.id, u.searchParams.get('token')!)).toBe(true);
      const other = body.find((g: { id: string }) => g.id !== f.id);
      expect(verifyToken(key, other.id, u.searchParams.get('token')!)).toBe(false);
    }
  });
});

describe('papers: upload', () => {
  it('test_upload_paper_rejects_cross_user_workspace', async () => {
    const r = await upload(as(USER_B_ID), { query: `?workspace_id=${seeded.workspace_a}` });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Workspace not found' });
  });

  it('happy path: 201, file on disk, file_path set, job enqueued', async () => {
    const r = await upload(as(USER_A_ID), { query: `?workspace_id=${seeded.workspace_a}` });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j).toMatchObject({ user_id: USER_A_ID, corpus_id: null, filename: 'test.pdf', status: 'pending', authors: [], tags: [] });
    expect(j.uploaded_at).toMatch(/Z$/);

    const onDisk = path.join(testStorageDirs().uploadDir, `${j.id}.pdf`);
    expect(fs.readFileSync(onDisk).equals(Buffer.from(PDF))).toBe(true);
    const [row] = await sql`SELECT file_path, corpus_id, status FROM papers WHERE id = ${j.id}`;
    expect(row).toMatchObject({ file_path: onDisk, corpus_id: seeded.workspace_a, status: 'pending' });

    const [job] = await sql`SELECT id, name, data FROM pgboss.job WHERE name = 'process_paper'`;
    expect(job!.data).toEqual({ paper_id: j.id });
    expect(await testQueue().getJobState(String(job!.id))).toMatchObject({ queue: 'process_paper', state: 'created' });
  });

  it('defaults to the default workspace (404 for a user who does not own it)', async () => {
    const r = await upload(as(USER_A_ID));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Workspace not found' });
  });

  it('accepts .PDF; rejects x.txt, bad magic and unknown workspace', async () => {
    const q = `?workspace_id=${seeded.workspace_a}`;
    expect((await upload(as(USER_A_ID), { query: q, filename: 'X.PDF' })).status).toBe(201);
    const txt = await upload(as(USER_A_ID), { query: q, filename: 'x.txt' });
    expect(txt.status).toBe(400);
    expect(await txt.json()).toEqual({ detail: 'Only PDF files are accepted' });
    const magic = await upload(as(USER_A_ID), { query: q, bytes: new TextEncoder().encode('%PDX-1.4') });
    expect(magic.status).toBe(400);
    expect(await magic.json()).toEqual({ detail: 'File is not a valid PDF (magic bytes missing)' });
    const ws = await upload(as(USER_A_ID), { query: `?workspace_id=${randomUUID()}` });
    expect(ws.status).toBe(404);
    expect(await ws.json()).toEqual({ detail: 'Workspace not found' });
  });

  it('missing file field is a pydantic-shaped 422', async () => {
    const r = await upload(as(USER_A_ID), { field: 'other' });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({
      detail: [{ type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null }],
    });
  });

  it('enqueue failure: 500 text and the row stays pending', async () => {
    const failing = createApp({
      ...(await deps()),
      queue: {
        send: async () => {
          throw new Error('boss down');
        },
      } as never,
    });
    const r = await upload(failing, { query: `?workspace_id=${seeded.workspace_a}` });
    expect(r.status).toBe(500);
    expect(await r.text()).toBe('Internal Server Error');
    const rows = await sql`SELECT status FROM papers WHERE filename = 'test.pdf'`;
    expect(rows.map((x) => x.status)).toEqual(['pending']);
  });
});

async function deps(): Promise<AppDeps> {
  const signingKey = resolveSigningKey({ DATABASE_URL: process.env.DATABASE_URL });
  const logger = pino({ level: 'silent' });
  return {
    sql,
    config: { ...loadConfig({ DATABASE_URL: process.env.DATABASE_URL, ENVIRONMENT: 'development' }), ...testStorageDirs() },
    logger,
    storage: new LocalStorage(testStorageDirs(), signingKey, logger),
    signingKey,
    env: {},
    userOverride: user(USER_A_ID),
    queue: testQueue(),
  };
}

describe('papers: upload size (test_upload_size_precheck)', () => {
  const q = () => `?workspace_id=${seeded.workspace_a}`;

  it('test_spoofed_content_length_413s_before_read', async () => {
    const r = await upload(as(USER_A_ID), { query: q(), headers: { 'content-length': '999999999' } });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ detail: 'File exceeds 50MB limit' });
  });

  it('test_small_upload_not_rejected_by_precheck', async () => {
    expect((await upload(as(USER_A_ID), { query: q() })).status).not.toBe(413);
  });

  it('test_post_read_oversize_is_413_not_400', async () => {
    const r = await upload(as(USER_A_ID, { maxUploadSizeMb: 0 }), { query: q() });
    expect(r.status).toBe(413);
    expect((await r.json()).detail).toContain('0MB limit');
  });

  it('Review Focus 2: a chunked body with no Content-Length is cut off, not read to the end', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const total = 60;
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= total * chunk.length) return controller.close();
        pulled += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const r = await as(USER_A_ID).request(`/papers${q()}`, {
      method: 'POST',
      body: stream,
      duplex: 'half',
      headers: csrfHeaders({ 'content-type': 'multipart/form-data; boundary=xx' }),
    } as RequestInit);
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ detail: 'File exceeds 50MB limit' });
    expect(pulled).toBeLessThan(total * chunk.length);
  });
});

describe('papers: rate limit', () => {
  it('after 50 uploads the next is 429; an invalid upload still uses a slot', async () => {
    const app = as(USER_A_ID, { authProvider: 'basic' });
    for (let i = 0; i < 50; i++) {
      expect((await upload(app, { filename: 'x.txt' })).status).toBe(400);
    }
    const r = await upload(app, { query: `?workspace_id=${seeded.workspace_a}` });
    expect(r.status).toBe(429);
    expect((await r.json()).detail).toMatch(/^Rate limit exceeded: 50 paper_upload per 24h/);
  });
});

describe('papers: delete', () => {
  it('204, files gone, audit row, feeds removed with the last paper of the corpus', async () => {
    const app = as(USER_A_ID);
    const up = await (await upload(app, { query: `?workspace_id=${seeded.workspace_a}` })).json();
    const pdf = path.join(testStorageDirs().uploadDir, `${up.id}.pdf`);
    const figDir = path.join(testStorageDirs().figuresDir, up.id);
    fs.mkdirSync(figDir, { recursive: true });
    fs.writeFileSync(path.join(figDir, 'f.png'), 'x');
    expect(fs.existsSync(pdf)).toBe(true);

    // seeded paper_a shares workspace_a: deleting one leaves feeds alone.
    expect((await client(app).delete(`/papers/${up.id}`)).status).toBe(204);
    expect(fs.existsSync(pdf)).toBe(false);
    expect(fs.existsSync(figDir)).toBe(false);
    expect(Number((await sql`SELECT COUNT(*) AS n FROM feeds WHERE id = ${seeded.feed_a}`)[0]!.n)).toBe(1);

    const r = await client(app).delete(`/papers/${seeded.paper_a}`);
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
    expect(Number((await sql`SELECT COUNT(*) AS n FROM feeds WHERE id = ${seeded.feed_a}`)[0]!.n)).toBe(0);
    // Another user's feed is untouched.
    expect(Number((await sql`SELECT COUNT(*) AS n FROM feeds WHERE id = ${seeded.feed_b}`)[0]!.n)).toBe(1);

    const [audit] = await sql`
      SELECT resource_type, resource_id, metadata, status_code FROM audit_log
      WHERE user_id = ${USER_A_ID} AND action = 'paper.delete' AND resource_id = ${seeded.paper_a}`;
    expect(audit).toMatchObject({
      resource_type: 'paper',
      status_code: 204,
      metadata: { filename: 'a.pdf', corpus_id: seeded.workspace_a },
    });
  });

  it('404 for a missing or foreign paper', async () => {
    const r = await client(as(USER_B_ID)).delete(`/papers/${seeded.paper_a}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Paper not found' });
  });
});
