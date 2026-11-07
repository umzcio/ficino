import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { createSql, type Sql } from '../../src/db/sql.js';
import { restoreDatabase } from '../../src/restore/database.js';
import { RestoreError } from '../../src/restore/errors.js';
import { copyStorage, planStorageCopy, type FileCopyPlan, type ManifestEntry } from '../../src/restore/files.js';
import type { StorageDirs } from '../../src/storage/local.js';
import { createScratchDb } from '../helpers/db.js';
import {
  buildSyntheticDump,
  buildSyntheticStorage,
  md5Hex,
  SYN,
  SYNTHETIC_STORAGE_KEYS as KEYS,
} from '../helpers/syntheticArchive.js';

const SOURCE_MODEL = 'voyage:voyage-4-large@1024';

let scratch: Awaited<ReturnType<typeof createScratchDb>>;
let sql: Sql;
/** Per test: `<base>/bucket` (the archive) and `<base>/out/{uploads,figures,media}` (the TS dirs). */
let base: string;
let bucket: string;
let dirs: StorageDirs;
let manifest: ManifestEntry[];

/** Every path below `root` (directories and files), not `root` itself. */
async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(root, e.name);
    out.push(p);
    if (e.isDirectory()) out.push(...(await walk(p)));
  }
  return out;
}

const roots = (): string[] => [dirs.uploadDir, dirs.figuresDir, dirs.mediaDir];

async function allTargetPaths(): Promise<string[]> {
  const out: string[] = [];
  for (const r of roots()) out.push(...(await walk(r)));
  return out;
}

/** A copy's target relative to the dir its kind lives in. */
function relTarget(c: FileCopyPlan['copies'][number]): string {
  const dir = c.kind === 'pdf' ? dirs.uploadDir : c.kind === 'figure' ? dirs.figuresDir : dirs.mediaDir;
  return relative(dir, c.to);
}

const plan = (m: ManifestEntry[] = manifest): Promise<FileCopyPlan> => planStorageCopy(sql, bucket, m, dirs);

describe('archive storage copy', () => {
  beforeAll(async () => {
    scratch = await createScratchDb();
    sql = createSql(scratch.url, { max: 3 });
    await migrate(sql);
    await restoreDatabase(sql, buildSyntheticDump(), { sourceEmbedModel: SOURCE_MODEL });
  });

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ficino-restore-files-'));
    bucket = join(base, 'bucket');
    const out = join(base, 'out');
    dirs = { uploadDir: join(out, 'uploads'), figuresDir: join(out, 'figures'), mediaDir: join(out, 'media') };
    manifest = await buildSyntheticStorage(bucket);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('maps PDFs, figures, audio and the episode into the TS layout', async () => {
    const p = await plan();
    expect(p.copies.map(relTarget).sort()).toEqual(
      [
        `${SYN.paperDefault}.pdf`,
        `${SYN.paperOther}.pdf`,
        `${SYN.paperDefault}/fig_p1_1.png`,
        `feeds/${SYN.feedPlain}/audio/post_0.mp3`,
        `feeds/${SYN.feedEpisode}/podcast/episode.mp3`,
      ].sort(),
    );
    const kinds = Object.fromEntries(p.copies.map((c) => [c.key, c.kind]));
    expect(kinds).toEqual({
      [KEYS.pdfDefault]: 'pdf',
      [KEYS.pdfOther]: 'pdf',
      [KEYS.figure]: 'figure',
      [KEYS.audio]: 'audio',
      [KEYS.episode]: 'episode',
    });
    for (const c of p.copies) {
      expect(c.from).toBe(join(bucket, c.key));
      expect(c.md5).toBe(md5Hex(await readFile(c.from)));
    }
    expect(p.missing).toEqual([]);

    expect(await copyStorage(p, dirs)).toEqual({ copied: 5 });
    for (const c of p.copies) {
      expect(md5Hex(await readFile(c.to)), c.key).toBe(md5Hex(await readFile(c.from)));
    }
    // Only the planned files landed (no temp files left behind).
    const files = [];
    for (const path of await allTargetPaths()) if ((await lstat(path)).isFile()) files.push(path);
    expect(files.sort()).toEqual(p.copies.map((c) => c.to).sort());
  });

  it('skips objects with no row', async () => {
    const p = await plan();
    const reasons = Object.fromEntries(p.skipped.map((s) => [s.key, s.reason]));
    expect(reasons).toEqual({
      [KEYS.pdfOrphan]: 'no papers row',
      [KEYS.strayFigure]: 'no figures row',
      [KEYS.legacySegment]: 'not a TS media key',
    });
    expect(p.copies.map((c) => c.key)).not.toContain(KEYS.pdfOrphan);
  });

  it('skips audio whose post carries another key, and an episode whose podcast is not ready', async () => {
    const extra = [
      `${SYN.owner}/feeds/${SYN.feedPlain}/audio/post_1.mp3`, // post 1 has no audio_key
      `${SYN.owner}/feeds/${SYN.feedPlain}/audio/post_00.mp3`, // not exactly post 0's key
      `${SYN.owner}/feeds/${SYN.feedLegacyPodcast}/podcast/episode.mp3`, // legacy podcast was cleared
      `${SYN.owner}/feeds/${SYN.feedPlain}/podcast/episode.mp3`, // never had a podcast
      `${SYN.owner}/notes.txt`,
      `${SYN.paperDefault}.pdf`, // no user prefix
    ];
    for (const k of extra) {
      await mkdir(join(bucket, k, '..'), { recursive: true });
      await writeFile(join(bucket, k), 'x');
    }
    const etag = `"${md5Hex(Buffer.from('x'))}"`;
    const p = await plan([...manifest, ...extra.map((name) => ({ name, size: 1, etag }))]);
    const reasons = Object.fromEntries(p.skipped.map((s) => [s.key, s.reason]));
    expect(reasons).toMatchObject({
      [extra[0]!]: 'no matching audio_key',
      [extra[1]!]: 'no matching audio_key',
      [extra[2]!]: 'podcast not ready',
      [extra[3]!]: 'podcast not ready',
      [extra[4]!]: 'not a TS media key',
      [extra[5]!]: 'not a TS media key',
    });
    expect(p.copies).toHaveLength(5);
  });

  it('aborts on a checksum mismatch before copying anything', async () => {
    await writeFile(join(bucket, KEYS.pdfOther), 'tampered bytes');
    await expect(plan()).rejects.toThrow(RestoreError);
    await expect(plan()).rejects.toThrow(/checksum mismatch: .*\.pdf/);
    expect(await allTargetPaths()).toEqual([]);
  });

  it('aborts on a same-size change too', async () => {
    const bytes = await readFile(join(bucket, KEYS.figure));
    bytes[0] = bytes[0]! ^ 0xff;
    await writeFile(join(bucket, KEYS.figure), bytes);
    await expect(plan()).rejects.toThrow(/checksum mismatch: .*fig_p1_1\.png/);
  });

  it('aborts when a planned source is absent', async () => {
    await unlink(join(bucket, KEYS.audio));
    await expect(plan()).rejects.toThrow(/source missing: .*post_0\.mp3/);
    expect(await allTargetPaths()).toEqual([]);
  });

  it('checks only the size of a multipart upload', async () => {
    const multipart = '"0123456789abcdef0123456789abcdef-2"';
    const m = manifest.map((e) => (e.name === KEYS.episode ? { ...e, etag: multipart } : e));
    const p = await plan(m);
    const ep = p.copies.find((c) => c.key === KEYS.episode)!;
    expect(ep.md5).toBeNull();
    expect(await copyStorage(p, dirs)).toEqual({ copied: 5 });
    expect(await readFile(ep.to)).toEqual(await readFile(ep.from));

    await expect(plan(m.map((e) => (e.name === KEYS.episode ? { ...e, size: e.size + 1 } : e)))).rejects.toThrow(
      /checksum mismatch: .*episode\.mp3/,
    );
  });

  it('aborts on an etag that is neither md5 nor multipart', async () => {
    const m = manifest.map((e) => (e.name === KEYS.pdfDefault ? { ...e, etag: 'W/"abc"' } : e));
    await expect(plan(m)).rejects.toThrow(/checksum mismatch: .*\.pdf/);
  });

  it('aborts when two objects map to the same target', async () => {
    const dup = `${SYN.orphan}/${SYN.paperDefault}.pdf`;
    await mkdir(join(bucket, SYN.orphan), { recursive: true });
    await writeFile(join(bucket, dup), 'other');
    const m = [...manifest, { name: dup, size: 5, etag: `"${md5Hex(Buffer.from('other'))}"` }];
    await expect(plan(m)).rejects.toThrow(/duplicate target: /);
  });

  it('rejects a key that escapes the bucket', async () => {
    // A file next to the bucket that a naive join would reach.
    await writeFile(join(base, 'escape.pdf'), 'outside');
    const unsafe = [
      `${SYN.owner}/../x.pdf`,
      `${SYN.owner}/../../escape.pdf`,
      `/${SYN.owner}/${SYN.paperDefault}.pdf`,
      `${SYN.owner}/feeds/${SYN.feedPlain}/audio/../audio/post_0.mp3`,
      `${SYN.owner}/${SYN.paperDefault}/figures/..`,
      `${SYN.owner}/./${SYN.paperOther}.pdf`,
      `${SYN.owner}//${SYN.paperOther}.pdf`,
      `${SYN.owner}\\..\\escape.pdf`,
      `${SYN.owner}/${SYN.paperDefault}/figures/.hidden.png`,
    ];
    const etag = '"00000000000000000000000000000000"';
    const p = await plan([...manifest, ...unsafe.map((name) => ({ name, size: 7, etag }))]);
    for (const k of unsafe) expect(p.skipped, k).toContainEqual({ key: k, reason: 'unsafe key' });
    expect(p.copies.filter((c) => unsafe.includes(c.key))).toEqual([]);
    await copyStorage(p, dirs);
    expect((await readdir(base)).sort()).toEqual(['bucket', 'escape.pdf', 'out']);
    expect((await readdir(join(base, 'out'))).sort()).toEqual(['figures', 'media', 'uploads']);
    expect((await allTargetPaths()).filter((x) => x.includes('escape') || x.endsWith('x.pdf'))).toEqual([]);
  });

  it('reports DB rows whose file is absent', async () => {
    await unlink(join(bucket, KEYS.figure));
    const p = await plan(manifest.filter((e) => e.name !== KEYS.figure && e.name !== KEYS.audio));
    expect(p.missing).toEqual(
      expect.arrayContaining([
        { kind: 'figure', id: SYN.figure, expected: join(dirs.figuresDir, SYN.paperDefault, 'fig_p1_1.png') },
        {
          kind: 'audio',
          id: `${SYN.feedPlain}/post_0`,
          expected: join(dirs.mediaDir, 'feeds', SYN.feedPlain, 'audio', 'post_0.mp3'),
        },
      ]),
    );
    expect(p.missing).toHaveLength(2);
  });

  it('does not report a row whose file is already in place', async () => {
    await mkdir(join(dirs.figuresDir, SYN.paperDefault), { recursive: true });
    await writeFile(join(dirs.figuresDir, SYN.paperDefault, 'fig_p1_1.png'), 'already here');
    const p = await plan(manifest.filter((e) => e.name !== KEYS.figure));
    expect(p.missing).toEqual([]);
  });

  it('reports every missing kind on an empty bucket', async () => {
    const p = await plan([]);
    expect(p.copies).toEqual([]);
    expect(p.missing.map((m) => `${m.kind}:${m.id}`).sort()).toEqual(
      [
        `pdf:${SYN.paperDefault}`,
        `pdf:${SYN.paperOther}`,
        `figure:${SYN.figure}`,
        `audio:${SYN.feedPlain}/post_0`,
        `episode:${SYN.feedEpisode}`,
      ].sort(),
    );
  });

  it('copying twice is harmless and files are 0644', async () => {
    const p = await plan();
    await copyStorage(p, dirs);
    expect(await copyStorage(p, dirs)).toEqual({ copied: 5 });
    const paths = await allTargetPaths();
    expect(paths.length).toBeGreaterThan(5);
    for (const path of paths) {
      const st = await lstat(path);
      expect(st.mode & 0o777, path).toBe(st.isDirectory() ? 0o755 : 0o644);
    }
    for (const c of p.copies) expect(md5Hex(await readFile(c.to))).toBe(md5Hex(await readFile(c.from)));
    // Re-planning after the copy finds nothing missing.
    expect((await plan()).missing).toEqual([]);
  });

  it('refuses a plan whose target is outside the storage dirs', async () => {
    const p = await plan();
    const bad: FileCopyPlan = { ...p, copies: [{ ...p.copies[0]!, to: join(base, 'stray.pdf') }] };
    await expect(copyStorage(bad, dirs)).rejects.toThrow(/unsafe target/);
    expect(await readdir(base)).not.toContain('stray.pdf');
  });

  it('a source changed after planning fails the copy and leaves no file behind', async () => {
    const p = await plan();
    const pdf = p.copies.find((c) => c.key === KEYS.pdfOther)!;
    await writeFile(pdf.from, 'changed after the plan');
    await expect(copyStorage(p, dirs)).rejects.toThrow(/checksum mismatch after copy: .*\.pdf/);
    expect(await readdir(dirs.uploadDir)).not.toContain(`${SYN.paperOther}.pdf`);
    expect((await allTargetPaths()).filter((x) => x.includes('.tmp-'))).toEqual([]);
  });

  it('neither chowns nor follows a symbolic link below a root', async () => {
    const outside = join(base, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'f'), 'x');
    await mkdir(dirs.mediaDir, { recursive: true });
    await symlink(outside, join(dirs.mediaDir, 'link-dir'));
    await symlink(join(outside, 'f'), join(dirs.mediaDir, 'link-file'));
    const calls: string[] = [];
    await copyStorage(await plan(), dirs, {
      chown: { uid: 4242, gid: 4242 },
      chownImpl: async (path) => {
        calls.push(path);
      },
    });
    expect(calls.filter((c) => c.includes('link-') || c.startsWith(outside))).toEqual([]);
    expect(calls).toContain(dirs.mediaDir);
  });

  it('chowns the roots, every created directory and every file', async () => {
    const calls: [string, number, number][] = [];
    const chownImpl = async (path: string, uid: number, gid: number): Promise<void> => {
      calls.push([path, uid, gid]);
    };
    await copyStorage(await plan(), dirs, { chown: { uid: 4242, gid: 4242 }, chownImpl });
    const expected = [...roots(), ...(await allTargetPaths())].sort();
    expect(calls.map((c) => c[0]).sort()).toEqual(expected);
    expect(new Set(calls.map((c) => c[0])).size).toBe(calls.length);
    expect(expected).toEqual(
      expect.arrayContaining([
        join(dirs.mediaDir, 'feeds'),
        join(dirs.mediaDir, 'feeds', SYN.feedPlain),
        join(dirs.mediaDir, 'feeds', SYN.feedPlain, 'audio'),
        join(dirs.mediaDir, 'feeds', SYN.feedEpisode, 'podcast'),
        join(dirs.figuresDir, SYN.paperDefault),
        join(dirs.uploadDir, `${SYN.paperDefault}.pdf`),
        join(dirs.mediaDir, 'feeds', SYN.feedEpisode, 'podcast', 'episode.mp3'),
      ]),
    );
    expect(calls.every(([, uid, gid]) => uid === 4242 && gid === 4242)).toBe(true);
  });

  it.skipIf(process.getuid?.() !== 0)('chowns for real when root', async () => {
    await copyStorage(await plan(), dirs, { chown: { uid: 4242, gid: 4242 } });
    const paths = [...roots(), ...(await allTargetPaths())];
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths) {
      const st = await lstat(path);
      expect([st.uid, st.gid], path).toEqual([4242, 4242]);
    }
  });

  it('does not chown without the option', async () => {
    let called = 0;
    await copyStorage(await plan(), dirs, {
      chownImpl: async () => {
        called += 1;
      },
    });
    expect(called).toBe(0);
    const st = await stat(dirs.uploadDir);
    expect(st.uid).toBe(process.getuid?.() ?? st.uid);
  });
});
