import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isUuid, UUID_PATTERN } from '../../src/shared/uuid.js';

describe('isUuid', () => {
  it('accepts lower- and upper-case hyphenated ids', () => {
    expect(isUuid('0a1b2c3d-4e5f-6789-abcd-ef0123456789')).toBe(true);
    expect(isUuid('0A1B2C3D-4E5F-6789-ABCD-EF0123456789')).toBe(true);
  });

  it('rejects every other shape', () => {
    for (const v of [
      '0a1b2c3d4e5f6789abcdef0123456789',
      '{0a1b2c3d-4e5f-6789-abcd-ef0123456789}',
      'urn:uuid:0a1b2c3d-4e5f-6789-abcd-ef0123456789',
      '0a1b2c3d-4e5f-6789-abcd-ef0123456789\n',
      ' 0a1b2c3d-4e5f-6789-abcd-ef0123456789',
      '0a1b2c3d-4e5f-6789-abcd-ef012345678g',
      '',
      null,
      undefined,
      123,
    ]) {
      expect(isUuid(v), String(v)).toBe(false);
    }
  });

  it('exports the unanchored hyphenated pattern', () => {
    expect(UUID_PATTERN).toBe('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}');
  });

  it('guard: no other source file carries its own copy of the pattern', async () => {
    const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));
    const entries = await readdir(srcDir, { recursive: true, withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.ts')).map((e) => join(e.parentPath, e.name));
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const f of files) {
      if ((await readFile(f, 'utf8')).includes('[0-9a-f]{8}-')) offenders.push(relative(srcDir, f).split(sep).join('/'));
    }
    expect(offenders).toEqual(['shared/uuid.ts']);
  });
});
