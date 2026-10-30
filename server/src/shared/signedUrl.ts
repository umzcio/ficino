// HMAC signed URLs (port of shared/ficino_shared/signed_url.py).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { SIGNED_URL_DEFAULT_TTL } from './constants.js';

const defaultNow = (): number => Math.floor(Date.now() / 1000);

export function resolveSigningKey(env: {
  SIGNED_URL_KEY?: string;
  ENVIRONMENT?: string;
  DATABASE_URL?: string;
}): Buffer {
  const key = (env.SIGNED_URL_KEY ?? '').trim();
  if (key) return Buffer.from(key);

  if ((env.ENVIRONMENT ?? 'development') === 'production') {
    throw new Error(
      'SIGNED_URL_KEY is required when ENVIRONMENT=production. ' +
        'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  // Dev only: sha256 HEX string of DATABASE_URL + salt, used as the key bytes.
  return Buffer.from(
    createHash('sha256')
      .update((env.DATABASE_URL ?? '') + '::ficino-figure-salt')
      .digest('hex'),
  );
}

export function signWithExpiry(key: Buffer, resourceId: string, expires: number): string {
  const digest = createHmac('sha256', key).update(`${resourceId}:${expires}`).digest();
  return `${expires}.${digest.toString('base64url')}`;
}

export function signResource(
  key: Buffer,
  resourceId: string,
  ttl: number = SIGNED_URL_DEFAULT_TTL,
  nowSec: () => number = defaultNow,
): string {
  return signWithExpiry(key, resourceId, nowSec() + ttl);
}

export function verifyToken(
  key: Buffer,
  resourceId: string,
  token: string,
  nowSec: () => number = defaultNow,
): boolean {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const expiresStr = token.slice(0, dot);
  const digestB64 = token.slice(dot + 1);
  if (!/^\s*[+-]?\d+\s*$/.test(expiresStr)) return false;
  const expires = Number(expiresStr);

  if (expires < nowSec()) return false;

  const expected = signWithExpiry(key, resourceId, expires).split('.', 2)[1] ?? '';
  const a = Buffer.from(digestB64);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
