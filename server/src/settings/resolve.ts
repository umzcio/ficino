import type { Sql } from '../db/sql.js';
import {
  buildDefaults,
  isPublicDeployment,
  mergeSettings,
  reassertPublicDeployment,
  type Env,
  type Settings,
} from './schema.js';

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * A user's effective settings for one job: defaults (from `env`) + stored row,
 * reasserted under PUBLIC_DEPLOYMENT, deep-frozen. Pure per call: nothing is
 * written to process.env or shared state, so concurrent jobs cannot leak keys.
 */
export async function resolveUserSettings(
  sql: Sql,
  userId: string,
  env: Env,
): Promise<Readonly<Settings>> {
  const rows = await sql`SELECT settings FROM user_settings WHERE user_id = ${userId}`;
  let stored: unknown = rows[0]?.settings ?? {};
  if (typeof stored === 'string') stored = JSON.parse(stored);
  const user = (typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored : {}) as Record<string, unknown>;
  let merged = mergeSettings(buildDefaults(env), user);
  if (isPublicDeployment(env)) merged = reassertPublicDeployment(merged, env);
  return deepFreeze(merged);
}
