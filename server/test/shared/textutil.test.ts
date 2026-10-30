import { describe, it, expect } from 'vitest';
import { escapeLike } from '../../src/shared/textutil.js';

describe('escapeLike', () => {
  it('escapes backslash first, then % and _', () => {
    expect(escapeLike('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
  });
  it('leaves plain text alone', () => {
    expect(escapeLike('plain')).toBe('plain');
  });
});
