"""Search across papers, chunks, and feed posts."""

import json

import asyncpg
import structlog
from fastapi import APIRouter, Depends, Query

from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/search", tags=["search"])


@router.get("")
async def search(
    q: str = Query(..., min_length=1, description="Search query"),
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

    # Search papers by title, filename, authors
    paper_rows = await db.fetch(
        """SELECT id, title, filename, authors, year, status, chunk_count
           FROM papers
           WHERE status = 'complete' AND (
             title ILIKE $1
             OR filename ILIKE $1
             OR EXISTS (SELECT 1 FROM unnest(authors) a WHERE a ILIKE $1)
           )
           ORDER BY uploaded_at DESC
           LIMIT 10""",
        f"%{query}%",
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

    # Search chunks via tsvector full-text search
    chunk_rows = await db.fetch(
        """SELECT c.id, c.paper_id, c.section, c.content, c.chunk_index,
                  p.title AS paper_title, p.filename AS paper_filename,
                  ts_rank(c.search_vector, plainto_tsquery('english', $1)) AS rank
           FROM chunks c
           JOIN papers p ON c.paper_id = p.id
           WHERE c.search_vector @@ plainto_tsquery('english', $1)
           ORDER BY rank DESC
           LIMIT 15""",
        query,
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

    # Search feed posts by content
    feed_rows = await db.fetch(
        "SELECT id, posts, generated_at, post_count FROM feeds ORDER BY generated_at DESC LIMIT 20"
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

    logger.info("search_complete", papers=len(papers), chunks=len(chunks), posts=len(matching_posts))

    return {
        "query": query,
        "papers": papers,
        "chunks": chunks,
        "posts": matching_posts,
    }
