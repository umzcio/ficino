"""Search across papers, chunks, and feed posts."""

import json
import os

import asyncpg
import structlog
from fastapi import APIRouter, Depends, Query

from auth import AuthUser, get_current_user
from db.connection import get_db
from routers.replies import _escape_like

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/search", tags=["search"])


# Feature flag (2.20). When true, post search hits the normalized feed_posts
# table via tsvector — O(log n) indexed search. When false, falls back to
# the legacy in-memory JSONB scan. Default true after backfill verified
# parity; flip back to "false" by setting the env var if the new path
# misbehaves.
SEARCH_USE_NORMALIZED_POSTS = os.getenv("SEARCH_USE_NORMALIZED_POSTS", "true").lower() == "true"


@router.get("")
async def search(
    q: str = Query(..., min_length=1, description="Search query"),
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Search across papers, chunks, and feed posts.

    Uses PostgreSQL full-text search (tsvector) for chunks,
    and ILIKE for papers and posts.
    """
    query = q.strip()
    if not query:
        return {"papers": [], "chunks": [], "posts": []}

    logger.info("search", query=query)

    # Escape LIKE metachars so a user query like "50%" doesn't wildcard-match
    # everything. Backslash must be escaped first to avoid double-escaping the
    # escape char itself. Postgres uses `\` as the default LIKE escape.
    safe_query = _escape_like(query)

    # Search papers by title, filename, authors
    paper_rows = await db.fetch(
        """SELECT id, title, filename, authors, year, status, chunk_count
           FROM papers
           WHERE user_id = $2 AND status = 'complete' AND (
             title ILIKE $1
             OR filename ILIKE $1
             OR EXISTS (SELECT 1 FROM unnest(authors) a WHERE a ILIKE $1)
           )
           ORDER BY uploaded_at DESC
           LIMIT 10""",
        f"%{safe_query}%", user.id,
    )
    papers = [
        {
            "id": str(r["id"]),
            "title": r["title"] or r["filename"],
            "authors": r["authors"] or [],
            "year": r["year"],
            "chunk_count": r["chunk_count"],
        }
        for r in paper_rows
    ]

    # Search chunks via tsvector full-text search. Filter by user_id FIRST
    # via the denormalized column + chunks_user_id_idx so the planner can
    # bitmap-AND with the GIN scan. Without the column on chunks, a common
    # tsquery term (e.g. "neural") matched every tenant's chunks before the
    # post-JOIN ownership trim.
    chunk_rows = await db.fetch(
        """SELECT c.id, c.paper_id, c.section, c.content, c.chunk_index,
                  p.title AS paper_title, p.filename AS paper_filename,
                  ts_rank(c.search_vector, plainto_tsquery('english', $1)) AS rank
           FROM chunks c
           JOIN papers p ON c.paper_id = p.id
           WHERE c.user_id = $2
             AND c.search_vector @@ plainto_tsquery('english', $1)
           ORDER BY rank DESC
           LIMIT 15""",
        query, user.id,
    )
    chunks = [
        {
            "id": str(r["id"]),
            "paper_id": str(r["paper_id"]),
            "paper_title": r["paper_title"] or r["paper_filename"],
            "section": r["section"],
            "content": r["content"][:300],
            "rank": round(float(r["rank"]), 4),
        }
        for r in chunk_rows
    ]

    # Search feed posts — prefer the normalized feed_posts tsvector path
    # when the flag is on. Fall back to the legacy JSONB scan otherwise.
    if SEARCH_USE_NORMALIZED_POSTS:
        post_rows = await db.fetch(
            """SELECT fp.feed_id, fp.post_index, fp.persona, fp.post_type,
                      fp.content_text, fp.paper_ref, f.generated_at,
                      ts_rank(fp.search_vector, plainto_tsquery('english', $1)) AS rank
               FROM feed_posts fp
               JOIN feeds f ON fp.feed_id = f.id
               WHERE fp.user_id = $2
                 AND NOT fp.deleted
                 AND fp.search_vector @@ plainto_tsquery('english', $1)
               ORDER BY rank DESC, f.generated_at DESC
               LIMIT 10""",
            query, user.id,
        )
        matching_posts = [
            {
                "feed_id": str(r["feed_id"]),
                "post_index": r["post_index"],
                "persona": r["persona"],
                "post_type": r["post_type"],
                "content": (r["content_text"] or "")[:200],
                "paper_ref": r["paper_ref"],
                "generated_at": r["generated_at"],
                "rank": round(float(r["rank"]), 4),
            }
            for r in post_rows
        ]
    else:
        # Legacy path: in-memory JSONB scan. Kept behind the flag so we can
        # flip back if the tsvector path regresses. Remove once the new
        # path has been verified in production for a release cycle.
        feed_rows = await db.fetch(
            "SELECT id, posts, generated_at, post_count FROM feeds WHERE user_id = $1 ORDER BY generated_at DESC LIMIT 20",
            user.id,
        )
        matching_posts = []
        query_lower = query.lower()
        for feed in feed_rows:
            posts_data = feed["posts"]
            if isinstance(posts_data, str):
                posts_data = json.loads(posts_data)
            for i, post in enumerate(posts_data):
                content = str(post.get("content", "")).lower()
                paper_ref = str(post.get("paper_ref", "")).lower()
                if query_lower in content or query_lower in paper_ref:
                    matching_posts.append({
                        "feed_id": str(feed["id"]),
                        "post_index": i,
                        "persona": post.get("persona"),
                        "post_type": post.get("post_type"),
                        "content": str(post.get("content", ""))[:200],
                        "paper_ref": post.get("paper_ref"),
                        "generated_at": feed["generated_at"],
                    })
                    if len(matching_posts) >= 10:
                        break
            if len(matching_posts) >= 10:
                break

    logger.info(
        "search_complete",
        papers=len(papers), chunks=len(chunks), posts=len(matching_posts),
        post_path="normalized" if SEARCH_USE_NORMALIZED_POSTS else "jsonb_scan",
    )

    return {
        "query": query,
        "papers": papers,
        "chunks": chunks,
        "posts": matching_posts,
    }
