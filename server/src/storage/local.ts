// Port of the delete path of shared/ficino_shared/storage/local.py. Plan 02 extends this file.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WarnLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Remove {uploadDir}/{paperId}.pdf and {figuresDir}/{paperId}/ recursively. Idempotent; filesystem errors are
 * logged (when a logger is given) and swallowed. A paperId that is not a UUID does nothing, so it can never
 * name a path outside the two directories.
 */
export async function deletePaperArtifacts(
  config: Pick<Config, 'uploadDir' | 'figuresDir'>,
  paperId: string,
  logger?: WarnLogger,
): Promise<void> {
  if (!UUID_RE.test(paperId)) return;
  const targets: [string, boolean][] = [
    [join(config.uploadDir, `${paperId}.pdf`), false],
    [join(config.figuresDir, paperId), true],
  ];
  for (const [path, recursive] of targets) {
    try {
      await rm(path, { recursive, force: true });
    } catch (e) {
      logger?.warn({ paper_id: paperId, error: String(e).slice(0, 120) }, 'paper_artifact_cleanup_failed');
    }
  }
}
