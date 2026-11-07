/** The hyphenated UUID form Postgres prints, unanchored so other patterns can embed it. The only copy in src/. */
export const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const UUID_RE = new RegExp(`^${UUID_PATTERN}$`, 'i');

/** A hyphenated UUID string. Anything else cannot match a uuid column (Postgres would raise 22P02 on the cast). */
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
