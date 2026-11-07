// Copy the archived storage bucket into the TS storage layout (`storage/local.ts`). The archive kept every object
// under `<user>/…` in one bucket; the TS keeps PDFs by paper id, figures by paper id and basename, and feed media
// under `feeds/<feed>/…`, with no user id anywhere. Only objects a restored row points at are copied; everything is
// checksummed against the archive manifest before the first byte is written.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, chown, copyFile, lstat, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { UUID_PATTERN } from '../shared/uuid.js';
import type { StorageDirs } from '../storage/local.js';
import type { RestoreDb } from './cleanup.js';
import { RestoreError } from './errors.js';

/** An archive manifest row: `name` relative to the bucket root (`<user>/<…>`); `etag` a quoted md5 or `"<hex>-<n>"`. */
export type ManifestEntry = { name: string; size: number; etag: string };

/** `md5` is the expected hex digest, or null for a multipart upload (whose etag is not an md5; size is checked). */
export type PlannedCopy = {
  key: string;
  from: string;
  to: string;
  kind: 'pdf' | 'figure' | 'audio' | 'episode';
  md5: string | null;
};

export type FileCopyPlan = {
  copies: PlannedCopy[];
  skipped: { key: string; reason: string }[];
  /** Restored rows whose file is neither planned nor already in place. `expected` is the path the API would read. */
  missing: { kind: string; id: string; expected: string }[];
};

// Lowercase ids only (`UUID_PATTERN` is lowercase and these regexes take no `i` flag): uuid::text is lowercase and the
// archive's keys were built from it, so a key with any other spelling names no restored row.
const UUID = UUID_PATTERN;
const USER_PREFIX_RE = new RegExp(`^${UUID}/`);
const PDF_RE = new RegExp(`^(${UUID})\\.pdf$`);
const FIGURE_RE = new RegExp(`^(${UUID})/figures/([^/]+)$`);
const AUDIO_RE = new RegExp(`^feeds/(${UUID})/audio/post_(\\d+)\\.mp3$`);
const EPISODE_RE = new RegExp(`^feeds/(${UUID})/podcast/episode\\.mp3$`);
const MD5_ETAG_RE = /^"?([0-9a-f]{32})"?$/i;
const MULTIPART_ETAG_RE = /^"?[0-9a-f]{32}-\d+"?$/i;

/** True when `child` is strictly below `root` (both resolved). */
function within(root: string, child: string): boolean {
  const r = resolve(root);
  const c = resolve(child);
  return c !== r && c.startsWith(r + sep);
}

/**
 * A key the copy refuses to touch: empty, absolute, with a backslash or NUL, or with any empty, `.`, `..` or
 * dot-leading segment. Checked before the key is mapped, so no later join can leave the bucket or a target dir.
 */
function unsafeKey(name: unknown): boolean {
  if (typeof name !== 'string' || name === '' || name.startsWith('/') || /[\\\0]/.test(name)) return true;
  return name.split('/').some((seg) => seg === '' || seg.startsWith('.'));
}

/** The basename the figure route serves for a stored `image_path` (`routes/figures.ts`), or null if it serves none. */
function figureBasename(imagePath: string | null): string | null {
  const stored = imagePath ?? '';
  const name = stored.slice(stored.lastIndexOf('/') + 1);
  return name && !name.startsWith('.') && !name.includes('\\') ? name : null;
}

async function md5File(path: string): Promise<string> {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

type Feed = { id: string; podcast_status: string | null; posts: unknown };

/** What the restored database expects on disk. */
async function loadRows(sql: RestoreDb): Promise<{
  papers: Set<string>;
  figures: { id: string; paper_id: string | null; image_path: string | null }[];
  feeds: Map<string, Feed>;
}> {
  const papers = await sql`SELECT id::text AS id FROM papers`;
  const figures = await sql`SELECT id::text AS id, paper_id::text AS paper_id, image_path FROM figures ORDER BY id`;
  const feeds = await sql`SELECT id::text AS id, podcast_status, posts FROM feeds ORDER BY id`;
  return {
    papers: new Set(papers.map((r) => r.id as string)),
    figures: figures.map((r) => ({
      id: r.id as string,
      paper_id: r.paper_id as string | null,
      image_path: r.image_path as string | null,
    })),
    feeds: new Map(feeds.map((r) => [r.id as string, r as unknown as Feed])),
  };
}

const postsOf = (feed: Feed | undefined): unknown[] => (feed && Array.isArray(feed.posts) ? feed.posts : []);

const audioKeyOf = (post: unknown): unknown =>
  post && typeof post === 'object' ? (post as Record<string, unknown>).audio_key : undefined;

/**
 * Map every manifest object onto the TS layout, or skip it with a reason; checksum every planned source; list the
 * restored rows that will still have no file. Throws `RestoreError` (`checksum mismatch: <key>`, `source missing:
 * <key>`, `duplicate target: <key>`) before anything is written. Reads the database only.
 */
export async function planStorageCopy(
  sql: RestoreDb,
  bucketRoot: string,
  manifest: ManifestEntry[],
  dirs: StorageDirs,
): Promise<FileCopyPlan> {
  const rows = await loadRows(sql);
  const figureNames = new Map<string, Set<string>>();
  for (const f of rows.figures) {
    const name = figureBasename(f.image_path);
    if (!f.paper_id || !name) continue;
    if (!figureNames.has(f.paper_id)) figureNames.set(f.paper_id, new Set());
    figureNames.get(f.paper_id)!.add(name);
  }

  const copies: (PlannedCopy & { entry: ManifestEntry })[] = [];
  const skipped: FileCopyPlan['skipped'] = [];
  const skip = (key: string, reason: string): void => {
    skipped.push({ key, reason });
  };

  for (const entry of manifest) {
    const key = entry.name;
    if (unsafeKey(key) || !within(bucketRoot, join(bucketRoot, key))) {
      skip(String(key), 'unsafe key');
      continue;
    }
    if (!USER_PREFIX_RE.test(key)) {
      skip(key, 'not a TS media key');
      continue;
    }
    const rest = key.replace(USER_PREFIX_RE, '');
    let kind: PlannedCopy['kind'];
    let dir: string;
    let to: string;
    let m: RegExpExecArray | null;
    if ((m = PDF_RE.exec(rest))) {
      if (!rows.papers.has(m[1]!)) {
        skip(key, 'no papers row');
        continue;
      }
      [kind, dir] = ['pdf', dirs.uploadDir];
      to = join(dir, `${m[1]!}.pdf`);
    } else if ((m = FIGURE_RE.exec(rest))) {
      if (!figureNames.get(m[1]!)?.has(m[2]!)) {
        skip(key, 'no figures row');
        continue;
      }
      [kind, dir] = ['figure', dirs.figuresDir];
      to = join(dir, m[1]!, m[2]!);
    } else if ((m = AUDIO_RE.exec(rest))) {
      const post = postsOf(rows.feeds.get(m[1]!))[Number(m[2]!)];
      if (audioKeyOf(post) !== rest) {
        skip(key, 'no matching audio_key');
        continue;
      }
      [kind, dir] = ['audio', dirs.mediaDir];
      to = join(dir, rest);
    } else if ((m = EPISODE_RE.exec(rest))) {
      if (rows.feeds.get(m[1]!)?.podcast_status !== 'ready') {
        skip(key, 'podcast not ready');
        continue;
      }
      [kind, dir] = ['episode', dirs.mediaDir];
      to = join(dir, rest);
    } else {
      skip(key, 'not a TS media key');
      continue;
    }
    if (!within(dir, to)) {
      skip(key, 'unsafe key');
      continue;
    }
    copies.push({ key, from: join(bucketRoot, key), to, kind, md5: null, entry });
  }

  // Two objects for one file (e.g. the same paper id under two user prefixes): which one is right is unknowable.
  const targets = new Set<string>();
  for (const c of copies) {
    if (targets.has(c.to)) throw new RestoreError(`duplicate target: ${c.key}`);
    targets.add(c.to);
  }

  // Every source checks out before anything is written.
  for (const c of copies) {
    const st = await stat(c.from).catch(() => null);
    if (!st?.isFile()) throw new RestoreError(`source missing: ${c.key}`);
    if (st.size !== c.entry.size) throw new RestoreError(`checksum mismatch: ${c.key}`);
    const etag = typeof c.entry.etag === 'string' ? c.entry.etag : '';
    const md5 = MD5_ETAG_RE.exec(etag);
    if (md5) {
      if ((await md5File(c.from)) !== md5[1]!.toLowerCase()) throw new RestoreError(`checksum mismatch: ${c.key}`);
      c.md5 = md5[1]!.toLowerCase();
    } else if (!MULTIPART_ETAG_RE.test(etag)) {
      throw new RestoreError(`checksum mismatch: ${c.key}`);
    }
  }

  const missing = await missingFor(rows, dirs, targets);

  return { copies: copies.map(({ entry: _entry, ...c }) => c), skipped, missing };
}

/**
 * Restored rows the API will look for a file for, by the path it reads (audio is signed by post index,
 * `routes/feed.ts`), whose file is neither in `planned` nor already on disk.
 */
async function missingFor(
  rows: Awaited<ReturnType<typeof loadRows>>,
  dirs: StorageDirs,
  planned: ReadonlySet<string>,
): Promise<FileCopyPlan['missing']> {
  const missing: FileCopyPlan['missing'] = [];
  const requireFile = async (kind: string, id: string, expected: string | null): Promise<void> => {
    if (expected === null) missing.push({ kind, id, expected: '(no servable path)' });
    else if (!planned.has(expected) && !(await isFile(expected))) missing.push({ kind, id, expected });
  };
  for (const id of [...rows.papers].sort()) await requireFile('pdf', id, join(dirs.uploadDir, `${id}.pdf`));
  for (const f of rows.figures) {
    const name = figureBasename(f.image_path);
    await requireFile('figure', f.id, f.paper_id && name ? join(dirs.figuresDir, f.paper_id, name) : null);
  }
  for (const feed of rows.feeds.values()) {
    const posts = postsOf(feed);
    for (let i = 0; i < posts.length; i++) {
      if (!audioKeyOf(posts[i])) continue;
      const path = join(dirs.mediaDir, 'feeds', feed.id, 'audio', `post_${i}.mp3`);
      await requireFile('audio', `${feed.id}/post_${i}`, path);
    }
    if (feed.podcast_status === 'ready') {
      await requireFile('episode', feed.id, join(dirs.mediaDir, 'feeds', feed.id, 'podcast', 'episode.mp3'));
    }
  }
  return missing;
}

/** Restored rows (every paper PDF, figure, post `audio_key` and `ready` episode) whose file is not on disk. */
export async function missingFiles(sql: RestoreDb, dirs: StorageDirs): Promise<FileCopyPlan['missing']> {
  return missingFor(await loadRows(sql), dirs, new Set());
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The archive manifest as `ManifestEntry`s. Accepts a JSON list of objects, or an object whose one property is that
 * list; each object needs a non-empty string `name`, a non-negative integer `size` and a string `etag` (`eTag` also
 * accepted), at the top level or inside a `metadata` object as the storage API lists them. Other fields are dropped.
 * Anything else throws `RestoreError` naming the entry index, never its content.
 */
export function parseManifest(value: unknown): ManifestEntry[] {
  let list = value;
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1) list = value[keys[0]!];
  }
  if (!Array.isArray(list)) {
    throw new RestoreError('manifest: expected a list of { name, size, etag } (or an object holding only that list)');
  }
  return list.map((raw, i) => {
    const meta = isRecord(raw) && isRecord(raw.metadata) ? raw.metadata : {};
    const pick = (...keys: string[]): unknown => {
      for (const src of [isRecord(raw) ? raw : {}, meta]) for (const k of keys) if (src[k] !== undefined) return src[k];
      return undefined;
    };
    const name = isRecord(raw) ? raw.name : undefined;
    const size = pick('size');
    const etag = pick('etag', 'eTag');
    if (
      typeof name !== 'string' ||
      name === '' ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      typeof etag !== 'string'
    ) {
      throw new RestoreError(`manifest entry ${i}: expected name (string), size (integer) and etag (string)`);
    }
    return { name, size, etag };
  });
}

/** `mkdir -p` that leaves every directory it creates at 0755 whatever the umask. */
async function mkdirs(dir: string): Promise<void> {
  const first = await mkdir(dir, { recursive: true, mode: 0o755 });
  if (!first) return;
  const top = resolve(first);
  for (let d = resolve(dir); ; d = dirname(d)) {
    await chmod(d, 0o755);
    if (d === top || dirname(d) === d) break;
  }
}

type ChownImpl = (path: string, uid: number, gid: number) => Promise<void>;

/**
 * `chown -R` over `root`: the root and every directory and file below it. Symbolic links below the root are neither
 * changed nor followed (`chown` follows a link, so changing one would change its target, wherever that is).
 */
async function chownTree(root: string, uid: number, gid: number, impl: ChownImpl): Promise<void> {
  await impl(root, uid, gid);
  for (const e of await readdir(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await chownTree(p, uid, gid, impl);
    else await impl(p, uid, gid);
  }
}

/**
 * Copy every planned object: create the target dirs (0755), copy to a temp file beside the target, chmod 0644,
 * re-checksum it (md5, or size for a multipart upload) and rename it into place, so a target is either the old file
 * or a verified copy. With `chown`, then `chown -R` the three storage roots, so every directory the copy created is
 * owned by the app user too: the api and worker write temp files inside those dirs and remove `feeds/<id>` trees.
 * Re-running is harmless (each target is replaced by the same bytes).
 */
export async function copyStorage(
  plan: FileCopyPlan,
  dirs: StorageDirs,
  opts: { chown?: { uid: number; gid: number }; chownImpl?: ChownImpl } = {},
): Promise<{ copied: number }> {
  const roots = [dirs.uploadDir, dirs.figuresDir, dirs.mediaDir];
  for (const c of plan.copies) {
    if (!roots.some((r) => within(r, c.to))) throw new RestoreError(`unsafe target: ${c.key}`);
  }
  for (const r of roots) await mkdirs(r);

  let copied = 0;
  for (const c of plan.copies) {
    await mkdirs(dirname(c.to));
    const tmp = `${c.to}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      await copyFile(c.from, tmp);
      await chmod(tmp, 0o644);
      const ok =
        c.md5 !== null
          ? (await md5File(tmp)) === c.md5
          : (await lstat(tmp)).size === (await stat(c.from)).size;
      if (!ok) throw new RestoreError(`checksum mismatch after copy: ${c.key}`);
      await rename(tmp, c.to);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    copied += 1;
  }

  if (opts.chown) {
    const { uid, gid } = opts.chown;
    const impl = opts.chownImpl ?? chown;
    for (const r of roots) await chownTree(r, uid, gid, impl);
  }
  return { copied };
}
