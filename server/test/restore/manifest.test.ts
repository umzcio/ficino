import { describe, expect, it } from 'vitest';
import { RestoreError } from '../../src/restore/errors.js';
import { parseManifest } from '../../src/restore/files.js';

const E = { name: 'u/p.pdf', size: 3, etag: '"0123456789abcdef0123456789abcdef"' };

describe('parseManifest', () => {
  it('reads a list of { name, size, etag }', () => {
    expect(parseManifest([E])).toEqual([E]);
  });

  it('reads the list out of a single-key wrapper object', () => {
    expect(parseManifest({ objects: [E] })).toEqual([E]);
  });

  it('reads size and etag from a storage-API style metadata object, and eTag spelled either way', () => {
    expect(parseManifest([{ name: E.name, metadata: { size: 3, eTag: E.etag, mimetype: 'application/pdf' } }])).toEqual([
      E,
    ]);
    expect(parseManifest([{ name: E.name, size: 3, eTag: E.etag }])).toEqual([E]);
  });

  it('keeps only name, size and etag', () => {
    expect(parseManifest([{ ...E, mimetype: 'application/pdf', extra: 1 }])).toEqual([E]);
  });

  it('rejects anything else, naming the entry index but not its content', () => {
    for (const bad of [
      null,
      'x',
      {},
      { a: [E], b: [E] },
      [{ ...E, name: '' }],
      [{ ...E, size: '3' }],
      [{ ...E, size: -1 }],
      [{ ...E, size: 1.5 }],
      [{ name: E.name, size: 3 }],
      [E, 'u/q.pdf'],
    ]) {
      expect(() => parseManifest(bad), JSON.stringify(bad)).toThrow(RestoreError);
    }
    try {
      parseManifest([E, { name: 'u/secret-name.pdf', size: 3 }]);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/manifest entry 1/);
      expect((e as Error).message).not.toContain('secret-name');
    }
  });
});
