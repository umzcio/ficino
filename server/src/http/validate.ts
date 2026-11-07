import type { Context } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import { pyLen } from '../shared/pystr.js';

type Source = 'json' | 'query' | 'param';

// Pydantic's loc[0] names: body | query | path.
const LOC: Record<Source, string> = { json: 'body', query: 'query', param: 'path' };

function make<T>(source: Source, schema: z.ZodType<T>) {
  return validator(source, (value, c: Context) => {
    const r = schema.safeParse(value, { reportInput: true });
    if (r.success) return r.data;
    const detail = r.error.issues.map((i) => ({
      type: i.code,
      loc: [LOC[source], ...i.path],
      msg: i.message,
      input: i.input ?? null,
    }));
    return c.json({ detail }, 422);
  });
}

export const body = <T>(schema: z.ZodType<T>) => make('json', schema);
export const query = <T>(schema: z.ZodType<T>) => make('query', schema);
export const params = <T>(schema: z.ZodType<T>) => make('param', schema);

/**
 * Python `int` query/path semantics (pydantic lax mode): integers, or strings that are an optionally
 * signed digit run with surrounding whitespace. `''`, `'0x10'`, `'1e3'` and `'5.0'` are rejected.
 */
export const pyInt = z
  .union([z.number().int(), z.string().regex(/^\s*[+-]?\d+\s*$/)])
  .transform((v) => Number(v));

const HEX32_RE = /^[0-9a-f]{32}$/;

/** Python `uuid.UUID(str)`: hyphens ignored, optional braces and `urn:uuid:` prefix; normalized to lowercase hyphenated. */
export const pyUuid = z.string().transform((v, ctx) => {
  const hex = v.toLowerCase().replace('urn:', '').replace('uuid:', '').replace(/^\{|\}$/g, '').replaceAll('-', '');
  if (!HEX32_RE.test(hex)) {
    ctx.addIssue({ code: 'custom', message: 'Input should be a valid UUID' });
    return z.NEVER;
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
});

const BOOL_TRUE = new Set(['1', 'true', 't', 'yes', 'y', 'on']);
const BOOL_FALSE = new Set(['0', 'false', 'f', 'no', 'n', 'off']);

/** Pydantic lax bool: JSON booleans or the case-insensitive strings 1 0 true false t f yes no y n on off. */
export const pyBool = z.union([z.boolean(), z.string()]).transform((v, ctx) => {
  if (typeof v === 'boolean') return v;
  const s = v.toLowerCase();
  if (BOOL_TRUE.has(s)) return true;
  if (BOOL_FALSE.has(s)) return false;
  ctx.addIssue({ code: 'custom', message: 'Input should be a valid boolean, unable to interpret input' });
  return z.NEVER;
});

/** Pydantic `max_length` on a str: counts code points, not UTF-16 units. */
export const pyMaxLen = (n: number) =>
  z.string().refine((s) => pyLen(s) <= n, { message: `String should have at most ${n} characters` });
