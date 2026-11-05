import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorker, type RunningWorker } from '../../src/worker/main.js';
import { CSRF_TEST_TOKEN, client, testApp, testStorageDirs } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, type Seeded } from '../helpers/db.js';
import { fakeProviders, type ChatPurpose } from '../helpers/fakeProviders.js';

const sql = testSql();
const SAMPLE = new Uint8Array(readFileSync(new URL('../fixtures/sample.pdf', import.meta.url)));
const WAIT = { timeout: 60000, interval: 100 };

let worker: RunningWorker | undefined;
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});
afterEach(async () => {
  await worker?.close();
  worker = undefined;
});

describe('conversations end to end: summaries, group chats, archivist, replies, zap, DMs', () => {
  it('runs every conversation surface in one process with fake providers', async () => {
    const dirs = testStorageDirs();
    const env = {
      DATABASE_URL: process.env.DATABASE_URL,
      AUTH_PROVIDER: 'none',
      ENVIRONMENT: 'development',
      LOG_LEVEL: 'silent',
      OLLAMA_BASE_URL: 'http://fake-ollama:11434',
      UPLOAD_DIR: dirs.uploadDir,
      FIGURES_DIR: dirs.figuresDir,
      MEDIA_DIR: dirs.mediaDir,
    };
    const purposes: ChatPurpose[] = [];
    const f = fakeProviders({
      chat: (_b, info) => {
        purposes.push(info.purpose);
        switch (info.purpose) {
          case 'metadata':
            return '{"title": "Sample Study", "authors": ["Ada Reader"], "year": 2024, "doi": null, "tags": []}';
          case 'context':
            return 'A situating sentence.';
          case 'classify':
            return 'extends';
          case 'persona':
            return JSON.stringify({ post_type: 'post', content: `A grounded take ${purposes.length}.` });
          case 'summary':
          case 'synthesis':
            return JSON.stringify([
              { role: info.purpose === 'summary' ? 'paper' : 'synthesis', type: 'tldr', content: `First ${info.purpose} take.` },
              { role: info.purpose === 'summary' ? 'paper' : 'synthesis', type: 'gap', content: `Second ${info.purpose} take.` },
            ]);
          case 'archivist':
            return `The archivist answers (${purposes.filter((p) => p === 'archivist').length}).`;
          case 'dm':
          case 'reply':
          case 'zap':
          case 'mention':
          case 'interjection':
            return `A ${info.purpose} answer.`;
          default:
            return 'Page text.';
        }
      },
    });
    worker = await startWorker(env, { providers: f.deps });

    const app = testApp({
      user: { id: USER_A_ID, email: 'auth-test-a@ficino.dev', display_name: 'A' },
      providers: f.deps,
      config: { ollamaBaseUrl: 'http://fake-ollama:11434' },
    });
    const c = client(app);
    await sql`
      INSERT INTO user_settings (user_id, settings) VALUES (${USER_A_ID}, ${sql.json({
        personas_enabled: { skeptic: true, hype: false, methodologist: false, practitioner: false, gradstudent: false },
        post_type_weights: { post: 1, thread: 0, quote: 0, reply: 0, figure: 0 },
        posts_per_generation: 2,
      } as never)})
      ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings`;

    const upload = async (): Promise<string> => {
      const form = new FormData();
      form.set('file', new File([SAMPLE as BlobPart], 'sample.pdf', { type: 'application/pdf' }));
      const up = await app.request(`/papers?workspace_id=${seeded.workspace_a}`, {
        method: 'POST',
        body: form,
        headers: { cookie: `ficino_csrf=${CSRF_TEST_TOKEN}`, 'x-csrf-token': CSRF_TEST_TOKEN },
      });
      if (up.status >= 300) throw new Error(`upload ${up.status} ${await up.text()}`);
      const id = String((await up.json()).id);
      await vi.waitFor(async () => {
        const [p] = await sql`SELECT status FROM papers WHERE id = ${id}`;
        expect(p!.status).toBe('complete');
      }, WAIT);
      return id;
    };

    // 1. Upload and ingest.
    const paperId = await upload();

    // 2. The first view dispatches the summary; the status poll reaches complete; the next view reads it.
    const first = await c.get(`/messages/papers/${paperId}`);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.status).toBe('generating');
    expect(firstBody.messages).toEqual([]);
    const summaryTask = String(firstBody.task_id);
    await vi.waitFor(async () => {
      const st = await (await c.get(`/messages/papers/${paperId}/status/${summaryTask}`)).json();
      expect(st).toEqual({ status: 'complete', paper_id: paperId });
    }, WAIT);
    const summary = await (await c.get(`/messages/papers/${paperId}`)).json();
    expect(summary.status).toBe('complete');
    expect(summary.messages).toEqual([
      { role: 'paper', type: 'tldr', content: 'First summary take.' },
      { role: 'paper', type: 'gap', content: 'Second summary take.' },
    ]);
    expect(typeof summary.generated_at).toBe('string');
    expect(summary.generated_at).toMatch(/Z$/);
    expect(summary.task_id).toBeUndefined();

    // 3. A second paper, then a group chat over both.
    const paper2 = await upload();
    const grp = await c.post('/messages/groups', { name: 'Both copies', paper_ids: [paperId, paper2] });
    expect(grp.status).toBe(202);
    const { synthesis_id: synthesisId } = await grp.json();
    let group: Record<string, any> = {};
    await vi.waitFor(async () => {
      group = await (await c.get(`/messages/groups/${synthesisId}`)).json();
      expect(group.status).toBe('complete');
    }, WAIT);
    expect(group.messages).toEqual([
      { role: 'synthesis', type: 'tldr', content: 'First synthesis take.' },
      { role: 'synthesis', type: 'gap', content: 'Second synthesis take.' },
    ]);
    expect(Object.keys(group.papers).sort()).toEqual([paperId, paper2].sort());

    // 4. An archivist post, then a follow-up.
    const created = await c.post('/user-posts', { content: 'What does the sample study find?', corpus_id: seeded.workspace_a });
    expect(created.status).toBe(201);
    const { id: postId } = await created.json();
    await vi.waitFor(async () => {
      expect((await (await c.get(`/user-posts/${postId}/status`)).json()).status).toBe('complete');
    }, WAIT);
    let post = await (await c.get(`/user-posts/${postId}`)).json();
    expect(post.replies).toHaveLength(1);
    expect(post.replies[0]).toMatchObject({ role: 'archivist', persona: 'archivist' });
    expect(post.replies[0].content).toContain('The archivist answers');
    expect(Array.isArray(post.sources)).toBe(true);
    expect(post.sources.length).toBeGreaterThan(0);

    const follow = await c.post(`/user-posts/${postId}/replies`, { content: 'And what are its limits?' });
    expect(follow.status).toBe(202);
    await vi.waitFor(async () => {
      expect((await (await c.get(`/user-posts/${postId}/status`)).json()).status).toBe('complete');
    }, WAIT);
    post = await (await c.get(`/user-posts/${postId}`)).json();
    expect(post.replies.map((r: { role: string }) => r.role)).toEqual(['archivist', 'user', 'archivist']);
    expect(post.replies[1].content).toBe('And what are its limits?');

    // 5. A feed (plan 03's route), a reply on post 0, a zap, and the conversations list.
    const gen = await c.post('/feed/generate', {});
    expect(gen.status).toBe(202);
    const { task_id: feedTask } = await gen.json();
    let fst: Record<string, any> = {};
    await vi.waitFor(async () => {
      fst = await (await c.get(`/feed/status/${feedTask}`)).json();
      expect(fst.status).toBe('complete');
    }, WAIT);
    const feedId = String(fst.feed_id);
    const feed = await (await c.get(`/feed/${feedId}`)).json();
    expect(feed.posts.length).toBeGreaterThan(0);
    const post0 = String(feed.posts[0].content);

    const reply = await c.post('/replies', {
      feed_id: feedId,
      post_index: 0,
      persona_key: 'skeptic',
      user_message: 'Is the sample large enough?',
      post_content: post0,
    });
    expect(reply.status).toBe(200);
    const replyBody = await reply.json();
    expect(replyBody.latest_response).toBe('A reply answer.');
    expect(replyBody.messages).toEqual([
      { role: 'user', content: 'Is the sample large enough?' },
      { role: 'persona', content: 'A reply answer.' },
    ]);

    const zap = await c.post('/replies/zap', {
      feed_id: feedId,
      post_index: 0,
      target_persona_key: 'hype',
      source_persona_key: 'skeptic',
      source_message: 'A reply answer.',
      post_content: post0,
    });
    expect(zap.status).toBe(200);
    const zapBody = await zap.json();
    expect(zapBody).toMatchObject({ id: replyBody.id, persona_key: 'hype', content: 'A zap answer.' });
    expect(zapBody.messages).toHaveLength(3);
    expect(zapBody.messages[2]).toEqual({ role: 'interjection', persona: 'hype', content: 'A zap answer.' });

    const convos = await (await c.get('/replies/conversations')).json();
    expect(convos).toHaveLength(1);
    expect(convos[0]).toMatchObject({
      id: replyBody.id,
      feed_id: feedId,
      post_index: 0,
      persona_key: 'skeptic',
      message_count: 3,
      last_user_message: 'Is the sample large enough?',
      last_persona_message: 'A reply answer.',
    });
    expect(convos[0].updated_at).toMatch(/\+00:00$/);

    // 6. A persona DM, then its thread.
    const dm = await c.post('/personas/skeptic/dm', { message: 'What worries you about this study?' });
    expect(dm.status).toBe(200);
    const dmBody = await dm.json();
    expect(dmBody.latest_response).toBe('A dm answer.');
    const thread = await (await c.get('/personas/skeptic/dm')).json();
    expect(thread).toEqual({
      id: dmBody.id,
      persona_key: 'skeptic',
      messages: [
        { role: 'user', content: 'What worries you about this study?' },
        { role: 'persona', content: 'A dm answer.' },
      ],
    });

    // Every chat the fakes answered was recognised, and each conversation surface was reached.
    expect(purposes.filter((p) => p === 'other')).toEqual([]);
    for (const p of ['summary', 'synthesis', 'archivist', 'persona', 'reply', 'zap', 'dm'] as const)
      expect(purposes).toContain(p);
    expect(purposes.filter((p) => p === 'archivist')).toHaveLength(2);
  }, 240000);
});
