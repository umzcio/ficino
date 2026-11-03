import { randomUUID } from 'node:crypto';
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

  it('traversal and malformed keys are 404 even with a valid token', async () => {
    for (const key of [
      `feeds/${seeded.feed_a}/audio/../../../../etc/passwd`,
      `feeds/${seeded.feed_a}/audio/..%2F..%2Fpost_1.mp3`,
      `feeds/not-a-uuid/audio/post_1.mp3`,
      `feeds/${seeded.feed_a}/audio/post_1.wav`,
    ]) {
      const r = await as(USER_A_ID).get(`/media/${key}?token=${signResource(signingKey, `media:${key}`)}`);
      expect(r.status, key).toBe(404);
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
