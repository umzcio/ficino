import bcrypt from 'bcryptjs';

const COST = 12;
const MAX_BYTES = 72;

export async function hashPassword(pw: string): Promise<string> {
  const hash = await bcrypt.hash(pw, await bcrypt.genSalt(COST));
  if (!hash.startsWith('$2b$12$')) throw new Error('unexpected bcrypt hash format');
  return hash;
}

// Compared against when the account has no usable hash, so unknown-email and bad-password
// logins cost the same.
let dummyHash: Promise<string> | undefined;

/**
 * False for a null hash and for passwords over 72 bytes (bcrypt would silently truncate them;
 * Python raised, giving a 500; here they are a plain mismatch).
 */
export async function verifyPassword(pw: string, hash: string | null): Promise<boolean> {
  if (Buffer.byteLength(pw, 'utf8') > MAX_BYTES) return false;
  if (hash === null) {
    dummyHash ??= hashPassword('ficino-dummy-password');
    await bcrypt.compare(pw, await dummyHash);
    return false;
  }
  try {
    return await bcrypt.compare(pw, hash);
  } catch {
    return false; // malformed stored hash
  }
}
