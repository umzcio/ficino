"""Hybrid vector + BM25 retrieval using pgvector and tsvector.

Cross-paper retrieval by default — chunks from all papers in corpus.
Blends cosine similarity (semantic) with ts_rank (keyword) for
academic text where author names, technical terms, and specific
phrases matter alongside conceptual similarity.
"""

import asyncio
import os

import structlog

from lib.db import fetch
from lib.embedder import embed_single_sync

logger = structlog.get_logger(__name__)

# Weight balance: 0.7 vector + 0.3 keyword
VECTOR_WEIGHT = 0.7
KEYWORD_WEIGHT = 0.3

# Distance threshold for vector-only matches (no keyword match)
# Higher = more permissive. bge-m3 distances tend to be larger than OpenAI's.
MAX_VECTOR_DISTANCE = 0.8


def retrieve_chunks(
    query: str,
    paper_ids: list[str] | None = None,
    top_k: int = 20,
) -> list[dict[str, object]]:
    """Retrieve top-k relevant chunks via hybrid vector + BM25 search.

    Args:
        query: The search query text
        paper_ids: Optional list of paper IDs to scope search. If None, searches all papers.
        top_k: Number of results to return

    Returns:
        List of dicts with keys: id, paper_id, section, content, chunk_type,
        chunk_index, token_count, score, match_type
    """
    logger.info("retrieval_start", query=query[:100], paper_ids=paper_ids, top_k=top_k)

    # Generate query embedding
    query_embedding = embed_single_sync(query)
    embedding_str = "[" + ",".join(str(x) for x in query_embedding) + "]"

    # Build the hybrid search query
    if paper_ids:
        placeholders = ",".join(f"${i+3}" for i in range(len(paper_ids)))
        paper_filter = f"AND c.paper_id IN ({placeholders})"
        args: list[object] = [embedding_str, query, *paper_ids, top_k]
    else:
        paper_filter = ""
        args = [embedding_str, query, top_k]

    top_k_param = f"${len(args)}"

    sql = f"""
    SELECT
        c.id,
        c.paper_id,
        c.section,
        c.content,
        c.chunk_type,
        c.chunk_index,
        c.token_count,
        p.title AS paper_title,
        p.authors AS paper_authors,
        p.year AS paper_year,
        p.filename AS paper_filename,
        (1 - (c.embedding <=> $1::vector)) * {VECTOR_WEIGHT} +
        COALESCE(ts_rank(c.search_vector, plainto_tsquery('english', $2)), 0) * {KEYWORD_WEIGHT} AS score,
        CASE
            WHEN c.search_vector @@ plainto_tsquery('english', $2)
                AND (c.embedding <=> $1::vector) < {MAX_VECTOR_DISTANCE}
            THEN 'hybrid'
            WHEN c.search_vector @@ plainto_tsquery('english', $2)
            THEN 'keyword'
            ELSE 'vector'
        END AS match_type
    FROM chunks c
    JOIN papers p ON c.paper_id = p.id
    WHERE (
        c.search_vector @@ plainto_tsquery('english', $2)
        OR (c.embedding <=> $1::vector) < {MAX_VECTOR_DISTANCE}
    )
    {paper_filter}
    ORDER BY score DESC
    LIMIT {top_k_param}
    """

    rows = fetch(sql, *args)

    results = []
    for row in rows:
        results.append({
            "id": str(row["id"]),
            "paper_id": str(row["paper_id"]),
            "section": row["section"],
            "content": row["content"],
            "chunk_type": row["chunk_type"],
            "chunk_index": row["chunk_index"],
            "token_count": row["token_count"],
            "paper_title": row["paper_title"],
            "paper_authors": row["paper_authors"] or [],
            "paper_year": row["paper_year"],
            "paper_filename": row["paper_filename"],
            "score": float(row["score"]),
            "match_type": row["match_type"],
        })

    logger.info("retrieval_complete", results=len(results),
                match_types={r["match_type"] for r in results})
    return results


_retrieval_queries_cache: dict[str, str] | None = None


def _get_retrieval_queries() -> dict[str, str]:
    """Load persona retrieval queries from the database (cached per worker process)."""
    global _retrieval_queries_cache
    if _retrieval_queries_cache is None:
        rows = fetch(
            "SELECT key, retrieval_query FROM personas WHERE is_active = true"
        )
        _retrieval_queries_cache = {row["key"]: row["retrieval_query"] for row in rows}
    return _retrieval_queries_cache


def retrieve_for_persona(
    persona_key: str,
    paper_ids: list[str] | None = None,
    top_k: int = 10,
    liked_paper_titles: list[str] | None = None,
) -> list[dict[str, object]]:
    """Retrieve chunks tailored for a specific persona's focus area.

    Each persona has a preferred section focus that influences the query.
    If liked_paper_titles is provided (from Phase 3 training signal),
    chunks from those papers get a score boost so they surface more often.
    """
    queries = _get_retrieval_queries()
    query = queries.get(persona_key, "key findings and methodology")
    results = retrieve_chunks(query, paper_ids=paper_ids, top_k=top_k * 2 if liked_paper_titles else top_k)

    if liked_paper_titles and results:
        # Boost scores for chunks from papers the user has liked posts about
        liked_set = {t.lower() for t in liked_paper_titles}
        for chunk in results:
            title = (chunk.get("paper_title") or "").lower()
            if any(liked in title or title in liked for liked in liked_set):
                chunk["score"] = chunk["score"] * LIKED_PAPER_BOOST
                chunk["boosted"] = True

        # Re-sort by score and take top_k
        results.sort(key=lambda c: c["score"], reverse=True)
        results = results[:top_k]

    return results


# Score multiplier for chunks from papers the user has liked posts about
LIKED_PAPER_BOOST = 1.25
