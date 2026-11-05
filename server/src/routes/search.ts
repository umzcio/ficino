// Port of api/routers/search.py (C §1.14).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { toPydanticIso } from '../db/time.js';
import { query } from '../http/validate.js';
import { LIMITS } from '../shared/constants.js';
import { pyRound, pySlice, pyStr, pyStrip } from '../shared/pystr.js';
import { escapeLike } from '../shared/textutil.js';

const searchQuery = z.object({ q: z.string().min(1) });

type JsonPost = Record<string, unknown>;

export function searchRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/', query(searchQuery), async (c) => {
    const { sql, config, logger } = c.var.deps;
    const userId = c.var.user.id;
    const q = pyStrip(c.req.valid('query').q);
    if (!q) return c.json({ papers: [], chunks: [], posts: [] });

    logger.info({ query: q }, 'search');
    const like = `%${escapeLike(q)}%`;

    const paperRows = await sql`
      SELECT id, title, filename, authors, year, status, chunk_count
      FROM papers
      WHERE user_id = ${userId} AND status = 'complete' AND (
        title ILIKE ${like}
        OR filename ILIKE ${like}
        OR EXISTS (SELECT 1 FROM unnest(authors) a WHERE a ILIKE ${like})
      )
      ORDER BY uploaded_at DESC
      LIMIT ${LIMITS.SEARCH}`;
    const papers = paperRows.map((x) => ({
      id: String(x.id),
      title: x.title || x.filename,
      authors: x.authors || [],
      year: x.year,
      chunk_count: x.chunk_count,
    }));

    const chunkRows = await sql`
      SELECT c.id, c.paper_id, c.section, c.content, c.chunk_index,
             p.title AS paper_title, p.filename AS paper_filename,
             ts_rank(c.search_vector, plainto_tsquery('english', ${q})) AS rank
      FROM chunks c
      JOIN papers p ON c.paper_id = p.id
      WHERE c.user_id = ${userId}
        AND c.search_vector @@ plainto_tsquery('english', ${q})
      ORDER BY rank DESC
      LIMIT ${LIMITS.SEARCH_CHUNKS}`;
    const chunks = chunkRows.map((x) => ({
      id: String(x.id),
      paper_id: String(x.paper_id),
      paper_title: x.paper_title || x.paper_filename,
      section: x.section,
      content: pySlice(String(x.content), 0, 300),
      rank: pyRound(Number(x.rank), 4),
    }));

    let posts: Array<Record<string, unknown>>;
    if (config.searchUseNormalizedPosts) {
      const rows = await sql`
        SELECT fp.feed_id, fp.post_index, fp.persona, fp.post_type,
               fp.content_text, fp.paper_ref, f.generated_at,
               ts_rank(fp.search_vector, plainto_tsquery('english', ${q})) AS rank
        FROM feed_posts fp
        JOIN feeds f ON fp.feed_id = f.id
        WHERE fp.user_id = ${userId}
          AND NOT fp.deleted
          AND fp.search_vector @@ plainto_tsquery('english', ${q})
        ORDER BY rank DESC, f.generated_at DESC
        LIMIT ${LIMITS.SEARCH}`;
      posts = rows.map((x) => ({
        feed_id: String(x.feed_id),
        post_index: x.post_index,
        persona: x.persona,
        post_type: x.post_type,
        content: pySlice(x.content_text || '', 0, 200),
        paper_ref: x.paper_ref,
        generated_at: toPydanticIso(x.generated_at),
        rank: pyRound(Number(x.rank), 4),
      }));
    } else {
      // Legacy in-memory scan of the 20 newest feeds, kept behind the flag.
      const feeds = await sql`
        SELECT id, posts, generated_at, post_count FROM feeds
        WHERE user_id = ${userId} ORDER BY generated_at DESC LIMIT 20`;
      posts = [];
      const needle = q.toLowerCase();
      outer: for (const feed of feeds) {
        const data = (typeof feed.posts === 'string' ? JSON.parse(feed.posts) : feed.posts) as JsonPost[];
        for (const [i, post] of data.entries()) {
          const content = pyStr(post.content ?? '');
          const ref = pyStr(post.paper_ref ?? '');
          if (content.toLowerCase().includes(needle) || ref.toLowerCase().includes(needle)) {
            posts.push({
              feed_id: String(feed.id),
              post_index: i,
              persona: post.persona ?? null,
              post_type: post.post_type ?? null,
              content: pySlice(content, 0, 200),
              paper_ref: post.paper_ref ?? null,
              generated_at: toPydanticIso(feed.generated_at),
            });
            if (posts.length >= 10) break outer;
          }
        }
      }
    }

    logger.info(
      {
        papers: papers.length,
        chunks: chunks.length,
        posts: posts.length,
        post_path: config.searchUseNormalizedPosts ? 'normalized' : 'jsonb_scan',
      },
      'search_complete',
    );
    return c.json({ query: q, papers, chunks, posts });
  });

  return r;
}
