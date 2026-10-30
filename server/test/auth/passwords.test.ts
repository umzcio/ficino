import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/passwords.js';

// python3 -c "import bcrypt;print(bcrypt.hashpw(b'correct horse battery', bcrypt.gensalt(12)).decode())"
const PYTHON_HASH = '$2b$12$bU7Om8eA7GCA7gahHt.7PenRP9ed4V0N2FT2CTugrxk7QfBfA1NTi';

describe('passwords', () => {
  it('hash is $2b$12$ and round-trips', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^\$2b\$12\$/);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong horse battery', h)).toBe(false);
  });

  it('verifies a Python-bcrypt hash of the same password', async () => {
    expect(await verifyPassword('correct horse battery', PYTHON_HASH)).toBe(true);
    expect(await verifyPassword('correct horse batterz', PYTHON_HASH)).toBe(false);
  });

  it('null or malformed hash never verifies', async () => {
    expect(await verifyPassword('correct horse battery', null)).toBe(false);
    expect(await verifyPassword('correct horse battery', 'not-a-hash')).toBe(false);
  });

  it('a password over 72 bytes never verifies, even against its own truncated hash', async () => {
    const h = await hashPassword('a'.repeat(72));
    expect(await verifyPassword('a'.repeat(72), h)).toBe(true);
    expect(await verifyPassword('a'.repeat(73), h)).toBe(false);
  });
});
