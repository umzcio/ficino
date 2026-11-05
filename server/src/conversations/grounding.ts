// Port of api/routers/replies.py `_load_reply_context_chunks`, `_load_grounding` and `_load_conversation_and_sources`.
import type { Sql } from '../db/sql.js';
import { pySlice, pyStrip } from '../shared/pystr.js';
import { escapeLike } from '../shared/textutil.js';
import { replyChunksText, type ConvoMessage } from './prompts.js';

export type ReplyChunk = {
  id: string;
  section: string | null;
  content: string;
  paper_id: string;
  paper_title: string | null;
  paper_filename: string | null;
};

export type GroundingInput = {
  userId: string;
  postSources: Array<Record<string, unknown>>;
  postContent: string;
  userMessage: string;
  paperRef: string | null;
};

const isDict = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const toChunk = (r: Record<string, any>): ReplyChunk => ({
  id: String(r.id),
  section: r.section,
  content: r.content,
  paper_id: String(r.paper_id),
  paper_title: r.paper_title,
  paper_filename: r.paper_filename,
});

/** Anchor chunks, then paper_ref fallback, then tsquery drift, then the first-5 legacy fallback. Deduped by id. */
export async function loadReplyContextChunks(sql: Sql, o: GroundingInput): Promise<ReplyChunk[]> {
  const chunks = new Map<string, ReplyChunk>();
  const sourcePaperIds = new Set<string>();
  const anchorChunkIds: string[] = [];
  for (const s of o.postSources ?? []) {
    const cid = isDict(s) ? s.chunk_id : null;
    const pid = isDict(s) ? s.paper_id : null;
    if (cid) anchorChunkIds.push(String(cid));
    if (pid) sourcePaperIds.add(String(pid));
  }

  // Layer 1: anchor chunks by chunk_id, owner-scoped.
  if (anchorChunkIds.length > 0) {
    const rows = await sql`
      SELECT c.id, c.section, c.content,
             c.paper_id, p.title AS paper_title, p.filename AS paper_filename
      FROM chunks c
      JOIN papers p ON c.paper_id = p.id
      WHERE c.id = ANY(${anchorChunkIds}::uuid[]) AND p.user_id = ${o.userId}`;
    for (const r of rows) {
      const c = toChunk(r);
      chunks.set(c.id, c);
      sourcePaperIds.add(c.paper_id);
    }
  }

  // paper_ref fallback when no paper was resolved from the sources.
  if (sourcePaperIds.size === 0 && o.paperRef) {
    const rawRef = o.paperRef.includes(' et al') ? o.paperRef.split(' et al')[0]! : pySlice(o.paperRef, 0, 30);
    const pattern = `%${escapeLike(rawRef)}%`;
    const rows = await sql`
      SELECT id FROM papers
      WHERE user_id = ${o.userId} AND (title ILIKE ${pattern} OR filename ILIKE ${pattern})
      ORDER BY uploaded_at DESC LIMIT 1`;
    if (rows[0]) sourcePaperIds.add(String(rows[0].id));
  }

  // Layer 2: drift search on the user's message plus a slice of the post.
  const parts = [o.userMessage];
  if (o.postContent) parts.push(pySlice(o.postContent, 0, 300));
  const driftQuery = pyStrip(parts.join(' '));
  const paperIds = [...sourcePaperIds];
  if (driftQuery && paperIds.length > 0) {
    const rows = await sql`
      SELECT c.id, c.section, c.content,
             c.paper_id, p.title AS paper_title, p.filename AS paper_filename,
             ts_rank(c.search_vector, plainto_tsquery('english', ${driftQuery})) AS rank
      FROM chunks c
      JOIN papers p ON c.paper_id = p.id
      WHERE c.paper_id = ANY(${paperIds}::uuid[]) AND p.user_id = ${o.userId}
        AND c.search_vector @@ plainto_tsquery('english', ${driftQuery})
      ORDER BY rank DESC LIMIT 5`;
    for (const r of rows) {
      const c = toChunk(r);
      if (!chunks.has(c.id)) chunks.set(c.id, c);
    }
  }

  // Legacy fallback: nothing found, so the first 5 chunks of the resolved paper(s).
  if (chunks.size === 0 && paperIds.length > 0) {
    const rows = await sql`
      SELECT c.id, c.section, c.content,
             c.paper_id, p.title AS paper_title, p.filename AS paper_filename
      FROM chunks c
      JOIN papers p ON c.paper_id = p.id
      WHERE c.paper_id = ANY(${paperIds}::uuid[]) AND p.user_id = ${o.userId}
      ORDER BY c.chunk_index LIMIT 5`;
    for (const r of rows) {
      const c = toChunk(r);
      chunks.set(c.id, c);
    }
  }

  return [...chunks.values()];
}

export async function loadGrounding(sql: Sql, o: GroundingInput): Promise<{ chunks: ReplyChunk[]; chunksText: string }> {
  const chunks = await loadReplyContextChunks(sql, o);
  return { chunks, chunksText: chunks.length > 0 ? replyChunksText(chunks) : '' };
}

/** The thread (unscoped; the route checks ownership first) and the post's sources (owner-scoped). */
export async function loadConversationAndSources(
  sql: Sql,
  userId: string,
  feedId: string,
  postIndex: number,
): Promise<{ replyId: string | null; messages: ConvoMessage[]; postSources: Array<Record<string, unknown>> }> {
  const [row] = await sql`SELECT id, messages FROM post_replies WHERE feed_id = ${feedId} AND post_index = ${postIndex}`;
  let replyId: string | null = null;
  let messages: ConvoMessage[] = [];
  if (row) {
    replyId = String(row.id);
    messages = row.messages as ConvoMessage[];
  }

  const [postRow] = await sql`SELECT posts FROM feeds WHERE id = ${feedId} AND user_id = ${userId}`;
  let postSources: Array<Record<string, unknown>> = [];
  if (postRow) {
    const posts = postRow.posts as unknown;
    if (Array.isArray(posts) && postIndex >= 0 && postIndex < posts.length) {
      const post = posts[postIndex];
      const raw = isDict(post) ? post.sources : null;
      if (Array.isArray(raw)) postSources = raw.filter(isDict);
    }
  }
  return { replyId, messages, postSources };
}
