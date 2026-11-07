import { RestoreError } from './errors.js';

/** One `COPY … FROM stdin;` block of a plain-text pg_dump. `rows` are the raw COPY text lines, without `\.`. */
export type CopyBlock = { schema: string; table: string; columns: string[]; rows: string[] };

/** Tables a restore never loads: the target's own seed and migration ledger win. */
export const DEFAULT_SKIPPED_TABLES: ReadonlySet<string> = new Set(['personas', 'schema_migrations']);

const COPY_FROM_STDIN = /^COPY\s.*\sFROM\s+stdin;$/i;
const UNQUOTED = /^[A-Za-z_][A-Za-z0-9_$]*/;

type Cursor = { s: string; i: number };

function skipSpace(c: Cursor): void {
  while (c.i < c.s.length && /\s/.test(c.s[c.i]!)) c.i++;
}

/** A quoted (`"a""b"`) or unquoted identifier at the cursor, or null. Unquoted names fold to lower case, as in SQL. */
function identifier(c: Cursor): string | null {
  if (c.s[c.i] === '"') {
    let out = '';
    let i = c.i + 1;
    for (;;) {
      const q = c.s.indexOf('"', i);
      if (q < 0) return null;
      out += c.s.slice(i, q);
      if (c.s[q + 1] === '"') {
        out += '"';
        i = q + 2;
        continue;
      }
      c.i = q + 1;
      return out;
    }
  }
  const m = UNQUOTED.exec(c.s.slice(c.i));
  if (!m) return null;
  c.i += m[0].length;
  return m[0].toLowerCase();
}

function take(c: Cursor, ch: string): boolean {
  skipSpace(c);
  if (c.s[c.i] !== ch) return false;
  c.i++;
  return true;
}

/** `COPY <schema>.<table> (<cols>) FROM stdin;`, or null when the statement has any other shape. */
function parseHeader(line: string): Omit<CopyBlock, 'rows'> | null {
  const c: Cursor = { s: line, i: 'COPY'.length };
  skipSpace(c);
  const schema = identifier(c);
  if (schema === null || c.s[c.i] !== '.') return null;
  c.i++;
  const table = identifier(c);
  if (table === null || !take(c, '(')) return null;
  const columns: string[] = [];
  for (;;) {
    skipSpace(c);
    const col = identifier(c);
    if (col === null) return null;
    columns.push(col);
    if (take(c, ',')) continue;
    if (take(c, ')')) break;
    return null;
  }
  skipSpace(c);
  if (!/^FROM\s+stdin;$/i.test(c.s.slice(c.i))) return null;
  return { schema, table, columns };
}

/**
 * Every `COPY … FROM stdin;` block of a plain-text pg_dump, in file order. Every other line (SET, `\restrict`,
 * comments, DDL, `COPY … TO`) is ignored. A FROM-stdin statement this parser cannot read throws rather than letting its
 * rows fall through as ignored lines; so does a block with no `\.` terminator. A data line is the terminator only when
 * it is exactly `\.` (an escaped backslash followed by a dot, `\\.`, is data).
 */
export function parseDump(text: string): CopyBlock[] {
  const lines = text.split('\n');
  const blocks: CopyBlock[] = [];
  let current: CopyBlock | null = null;
  for (let n = 0; n < lines.length; n++) {
    // COPY text escapes a carriage return in data as `\r`, so a raw one can only be part of a CRLF line ending.
    const line = lines[n]!.endsWith('\r') ? lines[n]!.slice(0, -1) : lines[n]!;
    if (current) {
      if (line === '\\.') {
        blocks.push(current);
        current = null;
      } else {
        current.rows.push(line);
      }
      continue;
    }
    if (!COPY_FROM_STDIN.test(line)) continue;
    const header = parseHeader(line);
    if (!header) throw new RestoreError(`unrecognised COPY statement at line ${n + 1}`);
    current = { ...header, rows: [] };
  }
  if (current) {
    throw new RestoreError(`COPY block for ${current.schema}.${current.table} is not terminated`);
  }
  return blocks;
}

/** The `public` blocks a restore loads: everything in `public` except the `skip` tables. */
export function publicBlocks(blocks: CopyBlock[], skip: ReadonlySet<string> = DEFAULT_SKIPPED_TABLES): CopyBlock[] {
  return blocks.filter((b) => b.schema === 'public' && !skip.has(b.table));
}
