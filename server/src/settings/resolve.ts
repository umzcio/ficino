import type { Sql } from '../db/sql.js';
import {
  buildDefaults,
  isPublicDeployment,
  mergeSettings,
  reassertPublicDeployment,
  type Env,
  type Settings,
} from './schema.js';
import { loadStoredSettings } from './stored.js';

export function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Pure core: defaults(env) + stored row, reasserted under PUBLIC_DEPLOYMENT, deep-frozen. */
export function resolveSettings(stored: Record<string, unknown>, env: Env): Readonly<Settings> {
  let merged = mergeSettings(buildDefaults(env), stored);
  if (isPublicDeployment(env)) merged = reassertPublicDeployment(merged, env);
  return deepFreeze(merged);
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
  const user = await loadStoredSettings(sql, userId);
  return resolveSettings(user, env);
}
