import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { formatApa, formatMla } from '../citations/format.js';
import { HttpError } from '../http/errors.js';
import { query } from '../http/validate.js';

const byTitleQuery = z.object({ title: z.string(), format: z.string().default('apa') });

export function citationsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/by-title', query(byTitleQuery), async (c) => {
    const { sql } = c.var.deps;
    const { title, format } = c.req.valid('query');
    // Unescaped ILIKE on the first 80 code points (Python title[:80]); LIMIT 1, no ORDER BY.
    const pattern = `%${Array.from(title).slice(0, 80).join('')}%`;
    const [row] = await sql`
      SELECT title, authors, year, doi FROM papers
      WHERE user_id = ${c.var.user.id} AND title ILIKE ${pattern} LIMIT 1`;
    if (!row) throw new HttpError(404, 'Paper not found');

    const paperTitle: string = row.title || title;
    const authors: string[] = row.authors ?? [];
    const year: number | null = row.year;
    const doi: string | null = row.doi;
    const citation = format === 'mla' ? formatMla(paperTitle, authors, year, doi) : formatApa(paperTitle, authors, year, doi);
    return c.json({ citation, format, title: paperTitle });
  });

  return r;
}
