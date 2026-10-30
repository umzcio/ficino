// Postgres text format: "YYYY-MM-DD HH:MM:SS[.ffffff]+00". Parsed with string operations
// because Date would truncate microseconds to milliseconds.
const PG_TS = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:[+-]00(?::?00)?)?$/;

function parts(pg: string): { date: string; time: string; frac: string } {
  const m = PG_TS.exec(pg);
  if (!m) throw new Error(`unsupported timestamp format: ${pg}`);
  return { date: m[1]!, time: m[2]!, frac: m[3] ? m[3].padEnd(6, '0') : '' };
}

/** Pydantic v2 JSON style: ...Z, fractional seconds only when non-zero. */
export function toPydanticIso(pg: string | null): string | null {
  if (pg === null) return null;
  const { date, time, frac } = parts(pg);
  return `${date}T${time}${frac ? `.${frac}` : ''}Z`;
}

/** Python datetime.isoformat() style: ...+00:00. */
export function toIsoformat(pg: string | null): string | null {
  if (pg === null) return null;
  const { date, time, frac } = parts(pg);
  return `${date}T${time}${frac ? `.${frac}` : ''}+00:00`;
}
