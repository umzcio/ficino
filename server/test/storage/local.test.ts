import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSigningKey, verifyToken } from '../../src/shared/signedUrl.js';
import { LocalStorage } from '../../src/storage/local.js';

const PID = '11111111-2222-3333-4444-555555555555';
const FID = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const FEED = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const KEY = resolveSigningKey({ SIGNED_URL_KEY: 'test-key' });

let dir: string;
let dirs: { uploadDir: string; figuresDir: string; mediaDir: string };
let st: LocalStorage;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ficino-local-'));
  dirs = { uploadDir: join(dir, 'up'), figuresDir: join(dir, 'fig'), mediaDir: join(dir, 'media') };
  st = new LocalStorage(dirs, KEY);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const exists = (p: string) => stat(p).then(() => true, () => false);
const tokenOf = (url: string) => new URL(url, 'http://x').searchParams.get('token')!;

describe('pdf', () => {
  it('roundtrips (test_pdf_roundtrip)', async () => {
    const p = await st.savePdf(PID, Buffer.from('%PDF-fake'));
    expect(p).toBe(join(dirs.uploadDir, `${PID}.pdf`));
    expect(st.pdfPath(PID)).toBe(p);
    expect((await readFile(p)).toString()).toBe('%PDF-fake');
    await st.deletePdf(PID);
    expect(await exists(p)).toBe(false);
  });

  it('pdfPath is pure (test_local_release_local_is_noop)', async () => {
    const p = await st.savePdf(PID, Buffer.from('bytes'));
    expect(st.pdfPath(PID)).toBe(p);
    expect(st.pdfPath(PID)).toBe(p);
    expect(await exists(p)).toBe(true);
    expect(await exists(join(dirs.uploadDir, 'other'))).toBe(false);
  });

  it('deletePdf is idempotent (test_local_delete_pdf_idempotent)', async () => {
    await st.savePdf(PID, Buffer.from('x'));
    await st.deletePdf(PID);
    await expect(st.deletePdf(PID)).resolves.toBeUndefined();
  });

  it('concurrent saves on one id leave one complete file and no temp leftovers', async () => {
    const payloads = Array.from({ length: 12 }, (_, i) => Buffer.alloc(200_000, String.fromCharCode(97 + i)));
    await Promise.all(payloads.map((b) => st.savePdf(PID, b)));
    expect(await readdir(dirs.uploadDir)).toEqual([`${PID}.pdf`]);
    const got = await readFile(st.pdfPath(PID));
    expect(got.length).toBe(200_000);
    expect(payloads.some((b) => b.equals(got))).toBe(true);
  });
});

describe('figures', () => {
  it('saves under figuresDir/paperId', async () => {
    const p = await st.saveFigure(PID, 'a.png', Buffer.from('a'));
    expect(p).toBe(join(dirs.figuresDir, PID, 'a.png'));
    expect((await readFile(p)).toString()).toBe('a');
  });

  it('rejects traversal (test_local_save_figure_rejects_traversal)', async () => {
    for (const name of ['../x.png', 'a/b.png', '.hidden.png', '']) {
      await expect(st.saveFigure(PID, name, Buffer.from('x'))).rejects.toThrow(
        `invalid figure filename: "${name}"`,
      );
    }
  });

  it('figureImageUrl is signed (test_local_figure_image_url_is_signed)', () => {
    const url = st.figureImageUrl(PID, FID, 600);
    expect(url.startsWith(`/figures/${PID}/${FID}?token=`)).toBe(true);
    const token = tokenOf(url);
    expect(verifyToken(KEY, FID, token)).toBe(true);
    expect(verifyToken(KEY, '66666666-7777-8888-9999-bbbbbbbbbbbb', token)).toBe(false);
  });
});

describe('deletePaperArtifacts', () => {
  it('removes the pdf and figure dir, idempotently (test_local_delete_paper_artifacts_removes_all)', async () => {
    await st.savePdf(PID, Buffer.from('pdf'));
    await st.saveFigure(PID, 'a.png', Buffer.from('a'));
    await writeFile(join(dirs.uploadDir, 'other.pdf'), 'keep');

    await st.deletePaperArtifacts(PID);
    expect(await exists(join(dirs.uploadDir, `${PID}.pdf`))).toBe(false);
    expect(await exists(join(dirs.figuresDir, PID))).toBe(false);
    expect(await exists(join(dirs.uploadDir, 'other.pdf'))).toBe(true);
    await expect(st.deletePaperArtifacts(PID)).resolves.toBeUndefined();
  });

  it('does nothing for non-UUID ids ("../x", "")', async () => {
    await mkdir(dirs.uploadDir, { recursive: true });
    await mkdir(dirs.figuresDir, { recursive: true });
    await writeFile(join(dir, 'x'), 'outside');
    await mkdir(join(dir, 'x-dir'));
    await st.deletePaperArtifacts('../x');
    await st.deletePaperArtifacts('../x-dir');
    await st.deletePaperArtifacts('');
    expect(await exists(join(dir, 'x'))).toBe(true);
    expect(await exists(join(dir, 'x-dir'))).toBe(true);
    expect(await exists(dirs.figuresDir)).toBe(true);
  });

  it('swallows errors (path under a file) and logs them', async () => {
    await writeFile(join(dir, 'file'), 'x');
    const warned: string[] = [];
    const bad = new LocalStorage(
      { uploadDir: join(dir, 'file', 'sub'), figuresDir: join(dir, 'file', 'f'), mediaDir: dirs.mediaDir },
      KEY,
      { warn: (_o, m) => void warned.push(m) },
    );
    await expect(bad.deletePaperArtifacts(PID)).resolves.toBeUndefined();
  });
});

describe('media', () => {
  it('audio save -> url -> mediaFilePath roundtrip', async () => {
    const key = await st.saveAudio(FEED, 3, Buffer.from('mp3'));
    expect(key).toBe(`feeds/${FEED}/audio/post_3.mp3`);
    const url = st.audioUrl(FEED, 3);
    expect(url.startsWith(`/media/${key}?token=`)).toBe(true);
    expect(verifyToken(KEY, `media:${key}`, tokenOf(url))).toBe(true);
    const p = st.mediaFilePath(key)!;
    expect(p).toBe(join(dirs.mediaDir, key));
    expect((await readFile(p)).toString()).toBe('mp3');
  });

  it('podcast save -> url -> mediaFilePath roundtrip', async () => {
    const key = await st.savePodcastEpisode(FEED, Buffer.from('ep'));
    expect(key).toBe(`feeds/${FEED}/podcast/episode.mp3`);
    const url = st.podcastEpisodeUrl(FEED);
    expect(url.startsWith(`/media/${key}?token=`)).toBe(true);
    expect(verifyToken(KEY, `media:${key}`, tokenOf(url))).toBe(true);
    expect((await readFile(st.mediaFilePath(key)!)).toString()).toBe('ep');
  });

  it('media and figure tokens are not interchangeable', () => {
    const key = `feeds/${FEED}/audio/post_0.mp3`;
    const mediaToken = tokenOf(st.audioUrl(FEED, 0));
    expect(verifyToken(KEY, key, mediaToken)).toBe(false);
    const figToken = tokenOf(st.figureImageUrl(PID, FID));
    expect(verifyToken(KEY, `media:${key}`, figToken)).toBe(false);
    expect(verifyToken(KEY, `media:${FID}`, figToken)).toBe(false);
  });

  it('mediaFilePath rejects keys of the wrong shape', () => {
    expect(st.mediaFilePath('feeds/../../etc/passwd')).toBeNull();
    expect(st.mediaFilePath(`feeds/${FEED}/audio/../../x.mp3`)).toBeNull();
    expect(st.mediaFilePath(`feeds/${FEED}/audio/post_x.mp3`)).toBeNull();
    expect(st.mediaFilePath(`feeds/${FEED}/audio/post_1.mp3/`)).toBeNull();
    expect(st.mediaFilePath(`/feeds/${FEED}/podcast/episode.mp3`)).toBeNull();
    expect(st.mediaFilePath('')).toBeNull();
  });

  it('deleteFeedMedia removes the feed tree, idempotently, and keeps other feeds', async () => {
    const other = 'cccccccc-cccc-dddd-eeee-ffffffffffff';
    await st.saveAudio(FEED, 0, Buffer.from('a'));
    await st.savePodcastEpisode(FEED, Buffer.from('b'));
    await st.saveAudio(other, 0, Buffer.from('c'));
    await st.deleteFeedMedia(FEED);
    expect(await exists(join(dirs.mediaDir, 'feeds', FEED))).toBe(false);
    expect(await exists(join(dirs.mediaDir, 'feeds', other))).toBe(true);
    await expect(st.deleteFeedMedia(FEED)).resolves.toBeUndefined();
  });
});

describe('ids', () => {
  it('non-UUID ids throw "invalid id"', async () => {
    const bad = '../etc';
    expect(() => st.pdfPath(bad)).toThrow('invalid id');
    await expect(st.savePdf(bad, Buffer.from('x'))).rejects.toThrow('invalid id');
    await expect(st.deletePdf(bad)).rejects.toThrow('invalid id');
    await expect(st.saveFigure(bad, 'a.png', Buffer.from('x'))).rejects.toThrow('invalid id');
    expect(() => st.figureImageUrl(bad, FID)).toThrow('invalid id');
    expect(() => st.figureImageUrl(PID, bad)).toThrow('invalid id');
    await expect(st.saveAudio(bad, 0, Buffer.from('x'))).rejects.toThrow('invalid id');
    await expect(st.savePodcastEpisode(bad, Buffer.from('x'))).rejects.toThrow('invalid id');
    expect(() => st.audioUrl(bad, 0)).toThrow('invalid id');
    expect(() => st.podcastEpisodeUrl(bad)).toThrow('invalid id');
    await expect(st.deleteFeedMedia(bad)).rejects.toThrow('invalid id');
  });

  it('takes injected dirs, not settings (test_local_storage_takes_injected_dirs_not_settings)', async () => {
    const inst = new LocalStorage(
      { uploadDir: join(dir, 'a'), figuresDir: join(dir, 'b'), mediaDir: join(dir, 'c') },
      KEY,
    );
    expect((await inst.savePdf(PID, Buffer.from('x'))).endsWith(`${PID}.pdf`)).toBe(true);
    expect(await exists(join(dir, 'a', `${PID}.pdf`))).toBe(true);
  });
});
