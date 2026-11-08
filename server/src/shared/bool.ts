const TRUE = new Set(['1', 'true', 't', 'yes', 'y', 'on']);
const FALSE = new Set(['0', 'false', 'f', 'no', 'n', 'off']);

/**
 * pydantic's bool spellings, trimmed and case-insensitive. Unset or blank uses the fallback (compose passes
 * `VAR=` as ''); anything else unrecognised throws, so a typo like `ALLOW_REGISTRATION=ture` fails at boot
 * instead of silently meaning the default.
 */
export function parseBool(name: string, v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  const s = v.trim().toLowerCase();
  if (s === '') return fallback;
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  throw new Error(`${name} must be a boolean, got: ${v}`);
}
