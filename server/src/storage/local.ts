// Port of shared/ficino_shared/storage/local.py (local backend only; Supabase storage was removed),
// plus audio/podcast media, which Python's local storage never had.
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { MEDIA_URL_TTL, SIGNED_URL_DEFAULT_TTL } from '../shared/constants.js';
import { signResource } from '../shared/signedUrl.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_KEY_RE =
  /^feeds\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(audio\/post_\d+|podcast\/episode)\.mp3$/i;

export interface WarnLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface StorageDirs {
  uploadDir: string;
  figuresDir: string;
  mediaDir: string;
}

function checkId(id: string): void {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('invalid id');
}

/** Write to a sibling temp file, then rename over the target, so readers never see a partial file. */
async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export class LocalStorage {
  constructor(
    private readonly dirs: StorageDirs,
    private readonly signingKey: Buffer,
    private readonly logger?: WarnLogger,
  ) {}

  pdfPath(paperId: string): string {
    checkId(paperId);
    return join(this.dirs.uploadDir, `${paperId}.pdf`);
  }

  async savePdf(paperId: string, bytes: Uint8Array): Promise<string> {
    const path = this.pdfPath(paperId);
    await atomicWrite(path, bytes);
    return path;
  }

  async deletePdf(paperId: string): Promise<void> {
    await rm(this.pdfPath(paperId), { force: true });
  }

  async saveFigure(paperId: string, filename: string, bytes: Uint8Array): Promise<string> {
    checkId(paperId);
    if (!filename || basename(filename) !== filename || filename.includes('\\') || filename.startsWith('.')) {
      throw new Error(`invalid figure filename: "${filename}"`);
    }
    const path = join(this.dirs.figuresDir, paperId, filename);
    await atomicWrite(path, bytes);
    return path;
  }

  /**
   * Remove {uploadDir}/{paperId}.pdf and {figuresDir}/{paperId}/ recursively. Idempotent; filesystem errors are
   * logged and swallowed. A paperId that is not a UUID does nothing, so it can never name a path outside the
   * two directories.
   */
  async deletePaperArtifacts(paperId: string): Promise<void> {
    if (!UUID_RE.test(paperId)) return;
    const targets: [string, boolean][] = [
      [join(this.dirs.uploadDir, `${paperId}.pdf`), false],
      [join(this.dirs.figuresDir, paperId), true],
    ];
    for (const [path, recursive] of targets) {
      try {
        await rm(path, { recursive, force: true });
      } catch (e) {
        this.logger?.warn({ paper_id: paperId, error: String(e).slice(0, 120) }, 'paper_artifact_cleanup_failed');
      }
    }
  }

  figureImageUrl(paperId: string, figureId: string, ttl: number = SIGNED_URL_DEFAULT_TTL): string {
    checkId(paperId);
    checkId(figureId);
    return `/figures/${paperId}/${figureId}?token=${signResource(this.signingKey, figureId, ttl)}`;
  }

  async saveAudio(feedId: string, postIndex: number, bytes: Uint8Array): Promise<string> {
    checkId(feedId);
    if (!Number.isInteger(postIndex) || postIndex < 0) throw new Error('invalid post index');
    return this.saveMedia(`feeds/${feedId}/audio/post_${postIndex}.mp3`, bytes);
  }

  async savePodcastEpisode(feedId: string, bytes: Uint8Array): Promise<string> {
    checkId(feedId);
    return this.saveMedia(`feeds/${feedId}/podcast/episode.mp3`, bytes);
  }

  audioUrl(feedId: string, postIndex: number, ttl: number = MEDIA_URL_TTL): string {
    checkId(feedId);
    if (!Number.isInteger(postIndex) || postIndex < 0) throw new Error('invalid post index');
    return this.mediaUrl(`feeds/${feedId}/audio/post_${postIndex}.mp3`, ttl);
  }

  podcastEpisodeUrl(feedId: string, ttl: number = MEDIA_URL_TTL): string {
    checkId(feedId);
    return this.mediaUrl(`feeds/${feedId}/podcast/episode.mp3`, ttl);
  }

  /** Absolute path for a media key, or null unless the key has exactly the shape this class writes. */
  mediaFilePath(key: string): string | null {
    if (typeof key !== 'string' || !MEDIA_KEY_RE.test(key)) return null;
    return join(this.dirs.mediaDir, key);
  }

  async deleteFeedMedia(feedId: string): Promise<void> {
    checkId(feedId);
    try {
      await rm(join(this.dirs.mediaDir, 'feeds', feedId), { recursive: true, force: true });
    } catch (e) {
      this.logger?.warn({ feed_id: feedId, error: String(e).slice(0, 120) }, 'feed_media_cleanup_failed');
    }
  }

  private async saveMedia(key: string, bytes: Uint8Array): Promise<string> {
    await atomicWrite(join(this.dirs.mediaDir, key), bytes);
    return key;
  }

  private mediaUrl(key: string, ttl: number): string {
    return `/media/${key}?token=${signResource(this.signingKey, `media:${key}`, ttl)}`;
  }
}
