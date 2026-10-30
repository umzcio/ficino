import { beforeEach, describe, expect, it } from 'vitest';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID, type Seeded } from '../helpers/db.js';

const sql = testSql();
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});
const as = (id: string) => client(testApp({ user: { id, email: `${id}@ficino.dev`, display_name: 'U' } }));
const asA = () => as(USER_A_ID);
const auditCount = async (action: string) =>
  Number((await sql`SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ${USER_A_ID} AND action = ${action}`)[0]!.n);

describe('tags', () => {
  it('test_create_tag_persists', async () => {
    const r = await asA().post('/tags', { name: 'methods' });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.name).toBe('methods');
    const [row] = await sql`SELECT name FROM tags WHERE id = ${j.id} AND user_id = ${USER_A_ID}`;
    expect(row!.name).toBe('methods');
  });

  it('test_create_tag_is_idempotent (existing returned with 201)', async () => {
    const r1 = await asA().post('/tags', { name: 'dup' });
    const r2 = await asA().post('/tags', { name: 'dup' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect((await r1.json()).id).toBe((await r2.json()).id);
  });

  it('test_create_tag_rejects_empty_name', async () => {
    const r = await asA().post('/tags', { name: '   ' });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ detail: 'Tag name cannot be empty' });
  });

  it('create trims the name', async () => {
    expect((await (await asA().post('/tags', { name: '  padded ' })).json()).name).toBe('padded');
  });

  it('test_list_tags_scoped_to_caller (with paper_count as a number)', async () => {
    await asA().post('/tags', { name: 'a-tag' });
    await sql`INSERT INTO tags (user_id, name) VALUES (${USER_B_ID}, 'b-tag')`;
    await asA().post('/tags/assign', { paper_id: seeded.paper_a, tag_name: 'a-tag' });
    const r = await asA().get('/tags');
    expect(r.status).toBe(200);
    const list = await r.json();
    expect(list.map((t: { name: string }) => t.name)).toEqual(['a-tag']);
    expect(list[0].paper_count).toBe(1);
  });

  it('test_delete_tag_removes_row', async () => {
    const { id } = await (await asA().post('/tags', { name: 'gone' })).json();
    const r = await asA().delete(`/tags/${id}`);
    expect(r.status).toBe(204);
    const [{ n }] = (await sql`SELECT COUNT(*) AS n FROM tags WHERE id = ${id}`) as unknown as { n: string }[];
    expect(Number(n)).toBe(0);
    expect(await auditCount('tag.delete')).toBe(1);
  });

  it('test_delete_missing_tag_returns_404', async () => {
    const r = await asA().delete(`/tags/${crypto.randomUUID()}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Tag not found' });
  });

  it('test_delete_cross_user_tag_returns_404', async () => {
    const [row] = await sql`INSERT INTO tags (user_id, name) VALUES (${USER_B_ID}, 'b-secret') RETURNING id`;
    expect((await asA().delete(`/tags/${row!.id}`)).status).toBe(404);
    expect((await sql`SELECT 1 FROM tags WHERE id = ${row!.id}`).length).toBe(1);
  });

  it('test_assign_tag_attaches_to_own_paper', async () => {
    const r = await asA().post('/tags/assign', { paper_id: seeded.paper_a, tag_name: 'important' });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j).toMatchObject({ paper_id: seeded.paper_a, tag_name: 'important' });
    const rows = await sql`
      SELECT 1 FROM paper_tags pt JOIN tags t ON pt.tag_id = t.id
      WHERE pt.paper_id = ${seeded.paper_a} AND t.name = 'important' AND t.user_id = ${USER_A_ID}`;
    expect(rows.length).toBe(1);
    // Assigning again reuses the tag and does not duplicate.
    const r2 = await asA().post('/tags/assign', { paper_id: seeded.paper_a, tag_name: 'important' });
    expect((await r2.json()).tag_id).toBe(j.tag_id);
  });

  it('test_assign_tag_rejects_foreign_paper', async () => {
    const r = await asA().post('/tags/assign', { paper_id: seeded.paper_b, tag_name: 'attempt' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Paper not found' });
  });

  it('test_assign_tag_rejects_empty_name', async () => {
    const r = await asA().post('/tags/assign', { paper_id: seeded.paper_a, tag_name: '  ' });
    expect(r.status).toBe(400);
  });

  it('test_assign_tag_rejects_cross_user_paper (IDOR: B tags A paper with own tag)', async () => {
    const b = as(USER_B_ID);
    expect([200, 201]).toContain((await b.post('/tags', { name: 'interesting' })).status);
    const r = await b.post('/tags/assign', { paper_id: seeded.paper_a, tag_name: 'interesting' });
    expect(r.status).toBe(404);
  });

  it('test_get_paper_tags_returns_assigned', async () => {
    await asA().post('/tags/assign', { paper_id: seeded.paper_a, tag_name: 'survey' });
    const r = await asA().get(`/tags/paper/${seeded.paper_a}`);
    expect(r.status).toBe(200);
    expect((await r.json()).map((t: { name: string }) => t.name)).toContain('survey');
  });

  it('test_get_tags_for_paper_scoped', async () => {
    await asA().post('/tags/assign', { paper_id: seeded.paper_a, tag_name: 'survey' });
    const r = await as(USER_B_ID).get(`/tags/paper/${seeded.paper_a}`);
    expect([200, 404]).toContain(r.status);
    if (r.status === 200) expect(await r.json()).toEqual([]);
  });

  it('test_unassign_tag_removes_association (and is idempotent, audited)', async () => {
    const { tag_id } = await (await asA().post('/tags/assign', { paper_id: seeded.paper_a, tag_name: 'remove-me' })).json();
    const r = await asA().delete(`/tags/assign/${seeded.paper_a}/${tag_id}`);
    expect(r.status).toBe(204);
    expect((await sql`SELECT 1 FROM paper_tags WHERE paper_id = ${seeded.paper_a} AND tag_id = ${tag_id}`).length).toBe(0);
    const again = await asA().delete(`/tags/assign/${seeded.paper_a}/${tag_id}`);
    expect(again.status).toBe(204);
    expect(await auditCount('tag.unassign')).toBe(2);
  });

  it('unassign cannot touch another user pairing', async () => {
    const { tag_id } = await (await asA().post('/tags/assign', { paper_id: seeded.paper_a, tag_name: 'keep' })).json();
    const r = await as(USER_B_ID).delete(`/tags/assign/${seeded.paper_a}/${tag_id}`);
    expect(r.status).toBe(204);
    expect((await sql`SELECT 1 FROM paper_tags WHERE paper_id = ${seeded.paper_a} AND tag_id = ${tag_id}`).length).toBe(1);
  });
});
