import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deletePaperArtifacts } from '../../src/storage/local.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ficino-local-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const exists = (p: string) => stat(p).then(() => true, () => false);

describe('deletePaperArtifacts', () => {
  it('removes the pdf and figure dir, idempotently (test_local_delete_paper_artifacts_removes_all)', async () => {
    const cfg = { uploadDir: join(dir, 'up'), figuresDir: join(dir, 'fig') };
    await mkdir(join(cfg.figuresDir, 'pid'), { recursive: true });
    await mkdir(cfg.uploadDir, { recursive: true });
    await writeFile(join(cfg.uploadDir, 'pid.pdf'), 'pdf');
    await writeFile(join(cfg.figuresDir, 'pid', 'a.png'), 'a');
    await writeFile(join(cfg.uploadDir, 'other.pdf'), 'keep');

    await deletePaperArtifacts(cfg, 'pid');
    expect(await exists(join(cfg.uploadDir, 'pid.pdf'))).toBe(false);
    expect(await exists(join(cfg.figuresDir, 'pid'))).toBe(false);
    expect(await exists(join(cfg.uploadDir, 'other.pdf'))).toBe(true);
    await expect(deletePaperArtifacts(cfg, 'pid')).resolves.toBeUndefined();
  });

  it('swallows errors (nonexistent dirs, path under a file)', async () => {
    await writeFile(join(dir, 'file'), 'x');
    await expect(
      deletePaperArtifacts({ uploadDir: join(dir, 'file', 'sub'), figuresDir: join(dir, 'file', 'f') }, 'p'),
    ).resolves.toBeUndefined();
  });
});
