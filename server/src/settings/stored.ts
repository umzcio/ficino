import type postgres from 'postgres';
import type { Sql } from '../db/sql.js';

const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isDict(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The one reader of `user_settings.settings`. A non-object value, or a string that does not
 * JSON-parse to a plain object, becomes `{}`; `__proto__`, `constructor` and `prototype` keys are dropped.
 * Pass a transaction handle as `sql` to read inside it (with `lock` for `FOR UPDATE`).
 */
export async function loadStoredSettings(
  sql: Sql | postgres.TransactionSql,
  userId: string,
  opts: { lock?: boolean } = {},
): Promise<Record<string, unknown>> {
  const rows = opts.lock
    ? await sql`SELECT settings FROM user_settings WHERE user_id = ${userId} FOR UPDATE`
    : await sql`SELECT settings FROM user_settings WHERE user_id = ${userId}`;
  let stored: unknown = rows[0]?.settings;
  if (typeof stored === 'string') {
    try {
      stored = JSON.parse(stored);
    } catch {
      return {};
    }
  }
  if (!isDict(stored)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored)) if (!BANNED_KEYS.has(k)) out[k] = v;
  return out;
}
