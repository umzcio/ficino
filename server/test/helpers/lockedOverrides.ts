import { buildDefaults, PROVIDER_OVERRIDE_KEYS, SECRET_KEYS, SETTINGS_TO_ENV } from '../../src/settings/schema.js';

/** Every provider/model override the PUBLIC_DEPLOYMENT lock takes from users (the secrets are carved out). */
export const LOCKED_NON_SECRET = [...PROVIDER_OVERRIDE_KEYS].filter((k) => !SECRET_KEYS.has(k)).sort();

/** A row a user could have stored before the lock: every non-secret override set to a marker value. */
export const STALE_ROW: Record<string, string> = Object.fromEntries(LOCKED_NON_SECRET.map((k) => [k, `stale-${k}`]));

/** The built-in default of each locked key (what the lock resolves to when the operator env is unset). */
export const BUILT_IN: Record<string, unknown> = Object.fromEntries(
  LOCKED_NON_SECRET.map((k) => [k, buildDefaults({})[k]]),
);

/** The operator env var of each locked key set to `value(key)`. */
export function envFor(value: (key: string) => string): Record<string, string> {
  return Object.fromEntries(LOCKED_NON_SECRET.map((k) => [SETTINGS_TO_ENV[k]!, value(k)]));
}

export const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));
