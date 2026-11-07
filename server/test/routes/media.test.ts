import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { client, testApp, testStorageDirs } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID, type Seeded } from '../helpers/db.js';
import { resolveSigningKey, signResource } from '../../src/shared/signedUrl.js';
import { LocalStorage } from '../../src/storage/local.js';

const sql = testSql();
const signingKey = resolveSigningKey({ DATABASE_URL: process.env.DATABASE_URL });
const storage = new LocalStorage(testStorageDirs(), signingKey);
const as = (id: string) => client(testApp({ user: { id, email: `${id}@ficino.dev`, display_name: 'U' } }));
const MP3 = Buffer.from('ID3-fake-mp3-bytes');

let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});

describe('GET /media/*', () => {
  it('roundtrip: audio and podcast urls from storage serve audio/mpeg', async () => {
    await storage.saveAudio(seeded.feed_a, 3, MP3);
    await storage.savePodcastEpisode(seeded.feed_a, MP3);
    for (const u of [storage.audioUrl(seeded.feed_a, 3), storage.podcastEpisodeUrl(seeded.feed_a)]) {
      const res = await testApp({ user: { id: USER_A_ID, email: 'a@x', display_name: null } }).request(u);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('audio/mpeg');
      expect(Buffer.from(await res.arrayBuffer()).equals(MP3)).toBe(true);
    }
  });

  it("another user's valid url is 404", async () => {
    await storage.saveAudio(seeded.feed_a, 0, MP3);
    const r = await as(USER_B_ID).get(storage.audioUrl(seeded.feed_a, 0));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Media not found' });
  });

  it('bad, expired, wrong-key and missing tokens', async () => {
    await storage.saveAudio(seeded.feed_a, 1, MP3);
    const key = `feeds/${seeded.feed_a}/audio/post_1.mp3`;
    const bad = await as(USER_A_ID).get(`/media/${key}?token=1999999999.AAAAAAAAAAAAAAAA`);
    expect(bad.status).toBe(403);
    expect(await bad.json()).toEqual({ detail: 'Invalid or expired media token' });
    expect((await as(USER_A_ID).get(`/media/${key}?token=${signResource(signingKey, `media:${key}`, -60)}`)).status).toBe(403);
    // A figure-style token (no media: prefix) must not open media.
    expect((await as(USER_A_ID).get(`/media/${key}?token=${signResource(signingKey, key)}`)).status).toBe(403);
    expect((await as(USER_A_ID).get(`/media/${key}`)).status).toBe(422);
  });

  it('malformed and encoded-traversal keys are 404 Media not found even with a valid token', async () => {
    // Literal `..` is collapsed by URL parsing before routing, so only encoded forms reach the route.
    for (const key of [
      `feeds/${seeded.feed_a}/audio/..%2F..%2Fpost_1.mp3`,
      `feeds/not-a-uuid/audio/post_1.mp3`,
      `feeds/${seeded.feed_a}/audio/post_1.wav`,
    ]) {
      const r = await as(USER_A_ID).get(`/media/${key}?token=${signResource(signingKey, `media:${key}`)}`);
      expect(r.status, key).toBe(404);
      expect(await r.json(), key).toEqual({ detail: 'Media not found' });
    }
  });

  it('404 Media file missing when owned and signed but absent', async () => {
    const key = `feeds/${seeded.feed_a}/audio/post_9.mp3`;
    const r = await as(USER_A_ID).get(`/media/${key}?token=${signResource(signingKey, `media:${key}`)}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Media file missing' });
  });

  it('404 Media not found for an unknown feed id', async () => {
    const key = `feeds/${randomUUID()}/audio/post_1.mp3`;
    const r = await as(USER_A_ID).get(`/media/${key}?token=${signResource(signingKey, `media:${key}`)}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: 'Media not found' });
  });
});

describe('GET /media/* byte ranges (deliberate change 8, Review Focus 2)', () => {
  const BYTES = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
  const appA = () => testApp({ user: { id: USER_A_ID, email: 'a@x', display_name: null } });
  const get = (url: string, headers: Record<string, string> = {}, method = 'GET') =>
    appA().request(url, { method, headers });
  const bodyOf = async (res: Response) => Buffer.from(await res.arrayBuffer());
  let url: string;
  beforeEach(async () => {
    await storage.saveAudio(seeded.feed_a, 0, BYTES);
    url = storage.audioUrl(seeded.feed_a, 0);
  });

  it('no Range: 200 with the whole file, accept-ranges, content-length, audio/mpeg', async () => {
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('100');
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('content-range')).toBeNull();
    expect((await bodyOf(res)).equals(BYTES)).toBe(true);
  });

  it.each([
    ['bytes=0-1', 0, 1],
    ['bytes=90-', 90, 99],
    ['bytes=-5', 95, 99],
    ['bytes=50-500', 50, 99],
    ['bytes=-500', 0, 99],
    ['bytes=7-7', 7, 7],
    ['bytes=99-99', 99, 99],
    ['Bytes=0-1', 0, 1],
  ])('%s: 206 with bytes %i-%i', async (range, start, end) => {
    const res = await get(url, { range });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes ${start}-${end}/100`);
    expect(res.headers.get('content-length')).toBe(String(end - start + 1));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect((await bodyOf(res)).equals(BYTES.subarray(start, end + 1))).toBe(true);
  });

  it.each(['bytes=100-', 'bytes=-0', 'bytes=500-600'])('%s: 416 with content-range bytes */100 and an empty body', async (range) => {
    const res = await get(url, { range });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */100');
    expect((await bodyOf(res)).length).toBe(0);
  });

  it.each(['bytes=0-1,5-6', 'items=0-1', 'bytes=5-2', 'bytes=', 'bytes=-', 'bytes=a-b', 'bytes=+1-2', 'bytes=0x1-2', 'bytes=1.0-2'])(
    '%s (several ranges, another unit or malformed): 200 with the whole file',
    async (range) => {
      const res = await get(url, { range });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe('100');
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      expect(res.headers.get('content-range')).toBeNull();
      expect((await bodyOf(res)).equals(BYTES)).toBe(true);
    },
  );

  it('any range on an empty file is 416 bytes */0; no Range is 200 with content-length 0', async () => {
    await storage.saveAudio(seeded.feed_a, 1, Buffer.alloc(0));
    const empty = storage.audioUrl(seeded.feed_a, 1);
    for (const range of ['bytes=0-1', 'bytes=0-', 'bytes=-5']) {
      const res = await get(empty, { range });
      expect(res.status, range).toBe(416);
      expect(res.headers.get('content-range'), range).toBe('bytes */0');
    }
    const res = await get(empty);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('0');
    expect((await bodyOf(res)).length).toBe(0);
  });

  it('HEAD answers the status and headers with an empty body and never opens a stream', async () => {
    const h206 = await get(url, { range: 'bytes=0-1' }, 'HEAD');
    expect(h206.status).toBe(206);
    expect(h206.headers.get('content-length')).toBe('2');
    expect(h206.headers.get('content-range')).toBe('bytes 0-1/100');
    expect(h206.headers.get('accept-ranges')).toBe('bytes');
    expect((await bodyOf(h206)).length).toBe(0);
    const h200 = await get(url, {}, 'HEAD');
    expect(h200.status).toBe(200);
    expect(h200.headers.get('content-length')).toBe('100');
    expect((await bodyOf(h200)).length).toBe(0);

    // A file larger than the stream buffers: a stream opened on it pauses with its descriptor open, where a tiny
    // file is read to EOF and auto-closed, which would hide the leak.
    await storage.saveAudio(seeded.feed_a, 2, Buffer.alloc(4 * 1024 * 1024, 7));
    const big = storage.audioUrl(seeded.feed_a, 2);
    const fds = () => readdirSync('/proc/self/fd').length;
    const before = fds();
    for (let i = 0; i < 50; i++) {
      const res = await get(big, i % 2 ? { range: 'bytes=0-1' } : {}, 'HEAD');
      expect(res.status).toBe(i % 2 ? 206 : 200);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fds() - before).toBeLessThanOrEqual(5);
  });

  it("a valid token for user B's feed key, as user A, is 404 Media not found with and without Range", async () => {
    await storage.saveAudio(seeded.feed_b, 0, BYTES);
    const bUrl = storage.audioUrl(seeded.feed_b, 0);
    for (const headers of [{}, { range: 'bytes=0-1' }] as Record<string, string>[]) {
      const res = await get(bUrl, headers);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ detail: 'Media not found' });
    }
  });

  it('a bad token is 403 before any range logic', async () => {
    const key = `feeds/${seeded.feed_a}/audio/post_0.mp3`;
    for (const range of ['bytes=0-1', 'bytes=100-']) {
      const res = await get(`/media/${key}?token=1999999999.AAAAAAAAAAAAAAAA`, { range });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ detail: 'Invalid or expired media token' });
    }
  });
});
