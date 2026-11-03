import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { client, testApp, testStorageDirs } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID, type Seeded } from '../helpers/db.js';
import { resolveSigningKey, signResource } from '../../src/shared/signedUrl.js';

const sql = testSql();
const key = resolveSigningKey({ DATABASE_URL: process.env.DATABASE_URL });
const as = (id: string) => client(testApp({ user: { id, email: `${id}@ficino.dev`, display_name: 'U' } }));
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082',
  'hex',
);

let seeded: Seeded;
let figureId: string;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
  figureId = randomUUID();
  const dir = path.join(testStorageDirs().figuresDir, seeded.paper_a);
  fs.mkdirSync(dir, { recursive: true });
  const disk = path.join(dir, `${figureId}.png`);
  fs.writeFileSync(disk, PNG);
  await sql`INSERT INTO figures (id, paper_id, page_number, image_path, extraction_type, description, claim_summary, figure_index)
            VALUES (${figureId}, ${seeded.paper_a}, 1, ${disk}, 'image', 'desc', 'claim', 0)`;
});

const url = (token?: string, fid = figureId, pid = seeded.paper_a) =>
  `/figures/${pid}/${fid}${token === undefined ? '' : `?token=${token}`}`;

describe('GET /figures/:paper_id/:figure_id', () => {
  it('test_signed_url_happy_path', async () => {
    const res = await testApp({ user: { id: USER_A_ID, email: 'a@x', display_name: null } }).request(
      url(signResource(key, figureId)),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('test_missing_token_rejected', async () => {
    const r = await as(USER_A_ID).get(url());
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({
      detail: [{ type: 'missing', loc: ['query', 'token'], msg: 'Field required', input: null }],
    });
  });

  it('token length bounds are 422', async () => {
    expect((await as(USER_A_ID).get(url('short'))).status).toBe(422);
    expect((await as(USER_A_ID).get(url('x'.repeat(201)))).status).toBe(422);
  });

  it('test_tampered_token_rejected', async () => {
    const t = signResource(key, figureId);
    const bad = t.slice(0, -2) + (t.endsWith('AA') ? 'BB' : 'AA');
    const r = await as(USER_A_ID).get(url(bad));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ detail: 'Invalid or expired figure token' });
  });

  it('test_expired_token_rejected', async () => {
    expect((await as(USER_A_ID).get(url(signResource(key, figureId, -60)))).status).toBe(403);
  });

  it('test_token_bound_to_figure_id', async () => {
    expect((await as(USER_A_ID).get(url(signResource(key, randomUUID())))).status).toBe(403);
  });

  it('test_cross_user_rejected_even_with_valid_token', async () => {
    const r = await as(USER_B_ID).get(url(signResource(key, figureId)));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Figure not found' });
  });

  it('test_figures_list_includes_signed_token (and the url works when followed)', async () => {
    const list = await (await as(USER_A_ID).get(`/papers/${seeded.paper_a}/figures`)).json();
    const entry = list.find((f: { id: string }) => f.id === figureId);
    expect(entry.image_url).toContain('token=');
    expect((await as(USER_A_ID).get(entry.image_url)).status).toBe(200);
  });

  it('404 when the file is gone; 400 for a dotfile image_path; the stored directory is ignored', async () => {
    await fs.promises.rm(path.join(testStorageDirs().figuresDir, seeded.paper_a, `${figureId}.png`));
    const gone = await as(USER_A_ID).get(url(signResource(key, figureId)));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ detail: 'Figure file missing' });

    await sql`UPDATE figures SET image_path = '/x/.hidden' WHERE id = ${figureId}`;
    const hidden = await as(USER_A_ID).get(url(signResource(key, figureId)));
    expect(hidden.status).toBe(400);
    expect(await hidden.json()).toEqual({ detail: 'Invalid image path' });

    await sql`UPDATE figures SET image_path = '/x/../../etc/passwd' WHERE id = ${figureId}`;
    expect((await as(USER_A_ID).get(url(signResource(key, figureId)))).status).toBe(404);
  });
});
