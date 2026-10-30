// Port of the delete path of shared/ficino_shared/storage/local.py. Plan 02 extends this file.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';

/** Remove {uploadDir}/{paperId}.pdf and {figuresDir}/{paperId}/ recursively. Idempotent; filesystem errors are swallowed. */
export async function deletePaperArtifacts(
  config: Pick<Config, 'uploadDir' | 'figuresDir'>,
  paperId: string,
): Promise<void> {
  try {
    await rm(join(config.uploadDir, `${paperId}.pdf`), { force: true });
  } catch {
    // best effort
  }
  try {
    await rm(join(config.figuresDir, paperId), { recursive: true, force: true });
  } catch {
    // best effort
  }
}
