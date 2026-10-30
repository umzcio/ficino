import type { Context } from 'hono';
import { validator } from 'hono/validator';
import type { z } from 'zod';

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
      input: i.input,
    }));
    return c.json({ detail }, 422);
  });
}

export const body = <T>(schema: z.ZodType<T>) => make('json', schema);
export const query = <T>(schema: z.ZodType<T>) => make('query', schema);
export const params = <T>(schema: z.ZodType<T>) => make('param', schema);
