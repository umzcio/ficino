import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_ID } from '../../src/shared/constants.js';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID, type Seeded } from '../helpers/db.js';

const sql = testSql();
let s: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  s = await seedUsers(sql);
});

const asUser = (id: string, email: string) => client(testApp({ user: { id, email, display_name: null } }));
const asA = () => asUser(USER_A_ID, 'auth-test-a@ficino.dev');
const asB = () => asUser(USER_B_ID, 'auth-test-b@ficino.dev');

async function secondWorkspaceForA(): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO corpora (id, user_id, name) VALUES (${id}, ${USER_A_ID}, 'Second')`;
  return id;
}

describe('/workspaces (test_workspaces.py)', () => {
  it('test_list_workspaces_returns_only_owned', async () => {
    const r = await asA().get('/workspaces');
    expect(r.status).toBe(200);
    const ids = new Set((await r.json()).map((w: { id: string }) => w.id));
    expect(ids.has(s.workspace_a)).toBe(true);
    expect(ids.has(s.workspace_b)).toBe(false);
  });

  it('test_list_workspaces_includes_counts', async () => {
    const rows = (await (await asA().get('/workspaces')).json()).filter((w: { id: string }) => w.id === s.workspace_a);
    expect(rows).toHaveLength(1);
    expect(rows[0].paper_count).toBe(1);
    expect(rows[0].feed_count).toBe(1);
    expect(Object.keys(rows[0])).toEqual(['id', 'name', 'paper_count', 'feed_count', 'last_activity', 'created_at']);
    expect(rows[0].created_at).toMatch(/Z$/);
    expect(rows[0].last_activity).toMatch(/Z$/);
  });

  it('list orders by last_activity DESC NULLS LAST', async () => {
    const empty = await secondWorkspaceForA();
    const rows = await (await asA().get('/workspaces')).json();
    expect(rows.map((w: { id: string }) => w.id)).toEqual([s.workspace_a, empty]);
    expect(rows[1].last_activity).toBeNull();
  });

  it('test_create_workspace_persists', async () => {
    const r = await asA().post('/workspaces', { name: 'Research' });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.name).toBe('Research');
    const [row] = await sql`SELECT name, user_id FROM corpora WHERE id = ${j.id}`;
    expect(row!.name).toBe('Research');
    expect(String(row!.user_id)).toBe(USER_A_ID);
  });

  it('create trims the name', async () => {
    const r = await asA().post('/workspaces', { name: '  Trim me ' });
    expect((await r.json()).name).toBe('Trim me');
  });

  it('test_create_workspace_rejects_empty_name', async () => {
    const r = await asA().post('/workspaces', { name: '   ' });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ detail: 'Workspace name cannot be empty' });
  });

  it('create without a name is 422', async () => {
    expect((await asA().post('/workspaces', {})).status).toBe(422);
  });

  it('test_rename_workspace_updates_name', async () => {
    const r = await asA().put(`/workspaces/${s.workspace_a}`, { name: 'Renamed' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: s.workspace_a, name: 'Renamed' });
    const [row] = await sql`SELECT name FROM corpora WHERE id = ${s.workspace_a}`;
    expect(row!.name).toBe('Renamed');
  });

  it('rename with empty name is 400', async () => {
    const r = await asA().put(`/workspaces/${s.workspace_a}`, { name: ' ' });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ detail: 'Workspace name cannot be empty' });
  });

  it('test_rename_cross_user_workspace_returns_404', async () => {
    const r = await asA().put(`/workspaces/${s.workspace_b}`, { name: 'hijacked' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Workspace not found' });
    const [row] = await sql`SELECT name FROM corpora WHERE id = ${s.workspace_b}`;
    expect(row!.name).toBe('B-ws');
  });

  it('test_delete_default_workspace_returns_400', async () => {
    const r = await asA().delete(`/workspaces/${DEFAULT_WORKSPACE_ID}`);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ detail: 'Cannot delete the default workspace' });
  });

  it('test_delete_only_workspace_returns_400', async () => {
    const r = await asA().delete(`/workspaces/${s.workspace_a}`);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ detail: 'Cannot delete your only workspace' });
  });

  it('test_delete_workspace_succeeds_when_not_last', async () => {
    const second = await secondWorkspaceForA();
    const r = await asA().delete(`/workspaces/${s.workspace_a}`);
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM corpora WHERE id = ${s.workspace_a}`;
    expect(n).toBe(0);
    const [paper] = await sql`SELECT corpus_id FROM papers WHERE id = ${s.paper_a}`;
    const [owner] = await sql`SELECT user_id FROM corpora WHERE id = ${paper!.corpus_id}`;
    expect(String(owner!.user_id)).toBe(USER_A_ID);
    expect(String(paper!.corpus_id)).toBe(second);
  });

  it('delete writes a workspace.delete audit row with moved_papers_to', async () => {
    const second = await secondWorkspaceForA();
    await asA().delete(`/workspaces/${s.workspace_a}`);
    const rows = await sql`
      SELECT resource_type, resource_id, metadata, status_code FROM audit_log
      WHERE user_id = ${USER_A_ID} AND action = 'workspace.delete'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resource_type: 'workspace',
      resource_id: s.workspace_a,
      metadata: { moved_papers_to: second },
      status_code: 204,
    });
  });

  it("delete never touches another user's papers or workspace", async () => {
    await secondWorkspaceForA();
    const r = await asA().delete(`/workspaces/${s.workspace_b}`);
    expect(r.status).toBe(204);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM corpora WHERE id = ${s.workspace_b}`;
    expect(n).toBe(1);
    const [p] = await sql`SELECT corpus_id FROM papers WHERE id = ${s.paper_b}`;
    expect(String(p!.corpus_id)).toBe(s.workspace_b);
  });

  it('test_delete_nonexistent_workspace_returns_404_not_400 (contract: 204)', async () => {
    await secondWorkspaceForA();
    const r = await asA().delete(`/workspaces/${randomUUID()}`);
    expect(r.status).toBe(204);
  });

  it('delete with a non-UUID id past the guards is 404 Not Found', async () => {
    await secondWorkspaceForA();
    const r = await asA().delete('/workspaces/not-a-uuid');
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Not Found' });
  });

  it('test_workspace_activity_returns_papers_and_feeds', async () => {
    const r = await asA().get(`/workspaces/${s.workspace_a}/activity`);
    expect(r.status).toBe(200);
    const types = new Set((await r.json()).map((a: { type: string }) => a.type));
    expect(types.has('paper_upload')).toBe(true);
  });

  it('test_workspace_activity_cross_user_returns_404 (also test_auth_scoping::test_get_workspace_activity_rejects_cross_user)', async () => {
    const r = await asA().get(`/workspaces/${s.workspace_b}/activity`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Workspace not found' });
    expect((await asB().get(`/workspaces/${s.workspace_a}/activity`)).status).toBe(404);
  });

  it('activity detail formats, DESC sort with NULL timestamps oldest, max 20', async () => {
    // Paper: title wins over filename; chunk_count/status in detail.
    await sql`UPDATE papers SET title = 'Nice Title', chunk_count = 7, status = 'complete',
              uploaded_at = '2026-01-01T00:00:00Z' WHERE id = ${s.paper_a}`;
    // Feed: with and without duration (0 and NULL are omitted).
    await sql`UPDATE feeds SET post_count = 3, paper_count = 2, generation_duration_ms = 12345,
              generated_at = '2026-03-01T00:00:00.5Z' WHERE id = ${s.feed_a}`;
    const f2 = randomUUID();
    const f3 = randomUUID();
    await sql`INSERT INTO feeds (id, user_id, corpus_id, posts, post_count, paper_count, generation_duration_ms, generated_at)
              VALUES (${f2}, ${USER_A_ID}, ${s.workspace_a}, '[]'::jsonb, 1, 1, 0, '2026-03-01T00:00:00Z'),
                     (${f3}, ${USER_A_ID}, ${s.workspace_a}, '[]'::jsonb, 4, 5, NULL, '2026-02-01T00:00:00Z')`;
    const paperNull = randomUUID();
    await sql`INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status, chunk_count, uploaded_at)
              VALUES (${paperNull}, ${USER_A_ID}, ${s.workspace_a}, 'null.pdf', '/tmp/n.pdf', 'processing', 0, NULL)`;

    const acts = await (await asA().get(`/workspaces/${s.workspace_a}/activity`)).json();
    expect(acts).toEqual([
      { type: 'feed_generation', title: 'Generated feed', detail: '3 posts · 2 papers · 12s', timestamp: '2026-03-01T00:00:00.500000Z' },
      { type: 'feed_generation', title: 'Generated feed', detail: '1 posts · 1 papers', timestamp: '2026-03-01T00:00:00Z' },
      { type: 'feed_generation', title: 'Generated feed', detail: '4 posts · 5 papers', timestamp: '2026-02-01T00:00:00Z' },
      { type: 'paper_upload', title: 'Nice Title', detail: '7 chunks · complete', timestamp: '2026-01-01T00:00:00Z' },
      { type: 'paper_upload', title: 'null.pdf', detail: '0 chunks · processing', timestamp: null },
    ]);
  });

  it('activity returns at most 20 (10 papers + 10 feeds per source)', async () => {
    for (let i = 0; i < 15; i++) {
      await sql`INSERT INTO papers (user_id, corpus_id, filename, file_path, status, chunk_count)
                VALUES (${USER_A_ID}, ${s.workspace_a}, ${`p${i}.pdf`}, '/tmp/x', 'complete', 1)`;
      await sql`INSERT INTO feeds (user_id, corpus_id, posts, post_count, paper_count)
                VALUES (${USER_A_ID}, ${s.workspace_a}, '[]'::jsonb, 1, 1)`;
    }
    const acts = await (await asA().get(`/workspaces/${s.workspace_a}/activity`)).json();
    expect(acts).toHaveLength(20);
  });

  it('requires a user (basic provider, no cookie) -> 401', async () => {
    const r = await client(testApp({ config: { authProvider: 'basic' } })).get('/workspaces');
    expect(r.status).toBe(401);
  });
});
