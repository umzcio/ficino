import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deletePaperArtifacts } from '../../src/storage/local.js';

const PID = '11111111-2222-3333-4444-555555555555';
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ficino-local-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const exists = (p: string) => stat(p).then(() => true, () => false);

describe('deletePaperArtifacts', () => {
  it('removes the pdf and figure dir, idempotently (test_local_delete_paper_artifacts_removes_all)', async () => {
    const cfg = { uploadDir: join(dir, 'up'), figuresDir: join(dir, 'fig') };
    await mkdir(join(cfg.figuresDir, PID), { recursive: true });
    await mkdir(cfg.uploadDir, { recursive: true });
    await writeFile(join(cfg.uploadDir, `${PID}.pdf`), 'pdf');
    await writeFile(join(cfg.figuresDir, PID, 'a.png'), 'a');
    await writeFile(join(cfg.uploadDir, 'other.pdf'), 'keep');

    await deletePaperArtifacts(cfg, PID);
    expect(await exists(join(cfg.uploadDir, `${PID}.pdf`))).toBe(false);
    expect(await exists(join(cfg.figuresDir, PID))).toBe(false);
    expect(await exists(join(cfg.uploadDir, 'other.pdf'))).toBe(true);
    await expect(deletePaperArtifacts(cfg, PID)).resolves.toBeUndefined();
  });

  it('does nothing for non-UUID ids ("../x", "")', async () => {
    const cfg = { uploadDir: join(dir, 'up'), figuresDir: join(dir, 'fig') };
    await mkdir(cfg.uploadDir, { recursive: true });
    await mkdir(cfg.figuresDir, { recursive: true });
    await writeFile(join(dir, 'x'), 'outside');
    await writeFile(join(dir, 'x.pdf'), 'outside');
    await mkdir(join(dir, 'x-dir'));
    await deletePaperArtifacts(cfg, '../x');
    await deletePaperArtifacts(cfg, '../x-dir');
    await deletePaperArtifacts(cfg, '');
    expect(await exists(join(dir, 'x'))).toBe(true);
    expect(await exists(join(dir, 'x-dir'))).toBe(true);
    expect(await exists(cfg.figuresDir)).toBe(true);
  });

  it('swallows errors (nonexistent dirs, path under a file)', async () => {
    await writeFile(join(dir, 'file'), 'x');
    await expect(
      deletePaperArtifacts({ uploadDir: join(dir, 'file', 'sub'), figuresDir: join(dir, 'file', 'f') }, PID),
    ).resolves.toBeUndefined();
  });
});
