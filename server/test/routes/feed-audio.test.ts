import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { reclaimMinutes } from '../../src/audio/feedAudio.js';
import { loadConfig } from '../../src/config.js';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, type Seeded } from '../helpers/db.js';
import { testBoss } from '../helpers/queue.js';

// Ports api/tests/test_feed_audio_rate_limit.py, plus the stale-claim re-dispatch (deliberate change 13).

const sql = testSql();
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});

type Line = Record<string, unknown> & { msg: string; level: number };
const base = loadConfig({ DATABASE_URL: process.env.DATABASE_URL, ENVIRONMENT: 'development' });
const MINUTES = reclaimMinutes(base.jobTimeLimitSec);
const userA = { id: USER_A_ID, email: 'auth-test-a@ficino.dev', display_name: 'A' };

function as(config: Record<string, unknown> = {}) {
  const lines: Line[] = [];
  const logger = pino({ level: 'debug' }, { write: (x: string) => void lines.push(JSON.parse(x) as Line) });
  return { c: client(testApp({ user: userA, config, logger })), lines };
}
const keyed = () => as({ elevenlabsApiKey: 'k' });
const limited = (audio: number) =>
  as({ elevenlabsApiKey: 'k', authProvider: 'basic', rateLimits: { ...base.rateLimits, audio } });

const ROUTES = [
  { route: 'audio', col: 'audio', queue: 'generate_audio_for_feed', log: 'feed_audio' },
  { route: 'podcast', col: 'podcast', queue: 'generate_podcast_for_feed', log: 'feed_podcast' },
] as const;

const jobCount = async (queue?: string) =>
  queue
    ? (await sql`SELECT COUNT(*)::int AS n FROM job_progress WHERE queue = ${queue}`)[0]!.n
    : (await sql`SELECT COUNT(*)::int AS n FROM job_progress`)[0]!.n;
const charged = async () =>
  (await sql`SELECT count FROM rate_limits WHERE key = ${`ratelimit:audio:${USER_A_ID}`}`)[0]?.count ?? 0;

async function setMedia(feedId: string, col: 'audio' | 'podcast', status: string | null, claimedMinutesAgo: number | null) {
  const claimedAt =
    claimedMinutesAgo === null ? null : sql`NOW() - make_interval(mins => ${claimedMinutesAgo}::int)`;
  if (col === 'audio') {
    await sql`UPDATE feeds SET audio_status = ${status}, audio_claimed_at = ${claimedAt} WHERE id = ${feedId}`;
  } else {
    await sql`UPDATE feeds SET podcast_status = ${status}, podcast_claimed_at = ${claimedAt} WHERE id = ${feedId}`;
  }
}
const mediaRow = async (feedId: string) =>
  (
    await sql`SELECT audio_status, audio_claimed_at, podcast_status, podcast_claimed_at
              FROM feeds WHERE id = ${feedId}`
  )[0];

async function newFeed(): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO feeds (id, user_id, corpus_id, posts, post_count)
            VALUES (${id}, ${USER_A_ID}, ${seeded.workspace_a}, '[]'::jsonb, 0)`;
  return id;
}

describe.each(ROUTES)('POST /feed/:feed_id/$route', ({ route, col, queue, log }) => {
  it('501 Audio TTS not configured without a key, before the id is looked at', async () => {
    const { c } = as();
    for (const id of [seeded.feed_a, randomUUID(), 'nope']) {
      const r = await c.post(`/feed/${id}/${route}`);
      expect(r.status).toBe(501);
      expect(await r.json()).toEqual({ detail: 'Audio TTS not configured' });
    }
    expect(await jobCount()).toBe(0);
  });

  it("404 Feed not found for another user's feed, an unknown id and a non-UUID", async () => {
    const { c } = keyed();
    for (const id of [seeded.feed_b, randomUUID(), 'nope']) {
      const r = await c.post(`/feed/${id}/${route}`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ detail: 'Feed not found' });
    }
    expect(await jobCount()).toBe(0);
  });

  it('a NULL status dispatches {feed_id} on its queue and leaves the feed row alone', async () => {
    const { c, lines } = keyed();
    const before = await mediaRow(seeded.feed_a);
    const r = await c.post(`/feed/${seeded.feed_a}/${route}`);
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j).toEqual({ status: 'generating', task_id: expect.any(String) });
    const [progress] = await sql`SELECT queue FROM job_progress WHERE job_id = ${j.task_id}`;
    expect(progress!.queue).toBe(queue);
    const b = await testBoss();
    expect((await b.getJobById(queue, j.task_id))!.data).toEqual({ feed_id: seeded.feed_a });
    expect(await mediaRow(seeded.feed_a)).toEqual(before);
    expect(lines.filter((l) => l.msg === `${log}_dispatched`)).toEqual([
      expect.objectContaining({ level: 30, feed_id: seeded.feed_a, task_id: j.task_id }),
    ]);
  });

  it('a failed status dispatches and is charged once', async () => {
    const { c } = limited(20);
    await setMedia(seeded.feed_a, col, 'failed', 30);
    const r = await c.post(`/feed/${seeded.feed_a}/${route}`);
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ status: 'generating', task_id: expect.any(String) });
    expect(await jobCount(queue)).toBe(1);
    expect(await charged()).toBe(1);
    expect((await mediaRow(seeded.feed_a))![`${col}_status`]).toBe('failed');
  });

  it('ready answers {status} with no job and no charge', async () => {
    const { c } = limited(1);
    await setMedia(seeded.feed_a, col, 'ready', 5);
    for (let i = 0; i < 3; i++) {
      const r = await c.post(`/feed/${seeded.feed_a}/${route}`);
      expect(r.status).toBe(202);
      expect(await r.json()).toEqual({ status: 'ready' });
    }
    expect(await jobCount()).toBe(0);
    expect(await charged()).toBe(0);
  });

  it('a fresh generating claim answers {status} with no job, no charge and no stale log', async () => {
    const { c, lines } = limited(1);
    for (const ago of [1, MINUTES - 1]) {
      await setMedia(seeded.feed_a, col, 'generating', ago);
      const r = await c.post(`/feed/${seeded.feed_a}/${route}`);
      expect(r.status).toBe(202);
      expect(await r.json()).toEqual({ status: 'generating' });
    }
    expect(await jobCount()).toBe(0);
    expect(await charged()).toBe(0);
    expect(lines.some((l) => l.msg === `${log}_stale_claim`)).toBe(false);
  });

  it('a generating row whose claim is past the reclaim window is charged and dispatched (deliberate change 13)', async () => {
    const { c, lines } = limited(20);
    await setMedia(seeded.feed_a, col, 'generating', MINUTES + 1);
    const { [`${col}_claimed_at`]: claimedAt } = (await mediaRow(seeded.feed_a))!;
    const r = await c.post(`/feed/${seeded.feed_a}/${route}`);
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j).toEqual({ status: 'generating', task_id: expect.any(String) });
    expect(await jobCount(queue)).toBe(1);
    expect(await charged()).toBe(1);
    expect(lines.filter((l) => l.msg === `${log}_stale_claim`)).toEqual([
      expect.objectContaining({ level: 40, feed_id: seeded.feed_a, claimed_at: claimedAt }),
    ]);
    // The API never writes the column: the new job's claim takes the row over.
    expect((await mediaRow(seeded.feed_a))![`${col}_status`]).toBe('generating');
    expect((await mediaRow(seeded.feed_a))![`${col}_claimed_at`]).toBe(claimedAt);
  });

  it('a generating row with a NULL claim is stale and dispatches', async () => {
    const { c, lines } = keyed();
    await setMedia(seeded.feed_a, col, 'generating', null);
    const r = await c.post(`/feed/${seeded.feed_a}/${route}`);
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ status: 'generating', task_id: expect.any(String) });
    expect(await jobCount(queue)).toBe(1);
    expect(lines.filter((l) => l.msg === `${log}_stale_claim`)).toEqual([
      expect.objectContaining({ level: 40, feed_id: seeded.feed_a, claimed_at: null }),
    ]);
  });

  it('the other column does not decide this route', async () => {
    const { c } = keyed();
    const other = col === 'audio' ? 'podcast' : 'audio';
    await setMedia(seeded.feed_a, other, 'ready', 1);
    const r = await c.post(`/feed/${seeded.feed_a}/${route}`);
    expect(await r.json()).toEqual({ status: 'generating', task_id: expect.any(String) });
  });

  it('fresh claim, then stale claim, then a third feed: the stale re-dispatch was charged exactly once', async () => {
    const { c } = limited(1);
    const fresh = await newFeed();
    const stale = await newFeed();
    const third = await newFeed();
    await setMedia(fresh, col, 'generating', 1);
    await setMedia(stale, col, 'generating', MINUTES + 5);

    const r1 = await c.post(`/feed/${fresh}/${route}`);
    expect(await r1.json()).toEqual({ status: 'generating' });
    const r2 = await c.post(`/feed/${stale}/${route}`);
    expect(r2.status).toBe(202);
    expect((await r2.json()).task_id).toEqual(expect.any(String));
    const r3 = await c.post(`/feed/${third}/${route}`);
    expect(r3.status).toBe(429);
    expect(await r3.json()).toEqual({ detail: 'Rate limit exceeded: 1 audio per 24h. Try again later.' });

    expect(await jobCount()).toBe(1);
    expect(await charged()).toBe(2); // the stale dispatch, then the rejected third (INCR-first)
  });
});

describe('the audio bucket', () => {
  it('ready and fresh generating never charge; a dispatch still succeeds; the next is 429 and sends no job', async () => {
    const { c } = limited(1);
    await setMedia(seeded.feed_a, 'audio', 'ready', 5);
    for (let i = 0; i < 3; i++) expect(await (await c.post(`/feed/${seeded.feed_a}/audio`)).json()).toEqual({ status: 'ready' });
    await setMedia(seeded.feed_a, 'audio', 'generating', 1);
    expect(await (await c.post(`/feed/${seeded.feed_a}/audio`)).json()).toEqual({ status: 'generating' });
    expect(await charged()).toBe(0);

    await setMedia(seeded.feed_a, 'audio', 'failed', 30);
    const ok = await c.post(`/feed/${seeded.feed_a}/audio`);
    expect(ok.status).toBe(202);
    expect((await ok.json()).status).toBe('generating');

    const over = await c.post(`/feed/${seeded.feed_a}/audio`);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ detail: 'Rate limit exceeded: 1 audio per 24h. Try again later.' });
    expect(await jobCount()).toBe(1);
    expect(await charged()).toBe(2); // INCR-first: the rejected hit still counts, as Python's limiter
  });

  it('is shared: after an audio dispatch a podcast dispatch is 429, and the reverse', async () => {
    const one = limited(1);
    expect((await one.c.post(`/feed/${seeded.feed_a}/audio`)).status).toBe(202);
    const r = await one.c.post(`/feed/${seeded.feed_a}/podcast`);
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ detail: 'Rate limit exceeded: 1 audio per 24h. Try again later.' });
    expect(await jobCount('generate_podcast_for_feed')).toBe(0);

    await sql`DELETE FROM rate_limits`;
    const two = limited(1);
    expect((await two.c.post(`/feed/${seeded.feed_a}/podcast`)).status).toBe(202);
    expect((await two.c.post(`/feed/${seeded.feed_a}/audio`)).status).toBe(429);
    expect(await jobCount()).toBe(2);
  });

  it('404 comes before the charge: an unknown feed with a spent bucket is still 404', async () => {
    const { c } = limited(0);
    const r = await c.post(`/feed/${randomUUID()}/audio`);
    expect(r.status).toBe(404);
    expect(await charged()).toBe(0);
  });
});
