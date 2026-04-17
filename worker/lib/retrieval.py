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

# Weight balance: 0.7 vector + 0.3 keyword by default.
# Overridable via env so ops can tune without code changes:
#   RETRIEVAL_VECTOR_WEIGHT=0.8 RETRIEVAL_KEYWORD_WEIGHT=0.2
# Values are clamped to [0.0, 1.0] but not forced to sum to 1.0 — if you
# want to scale the combined score just pick what works for your embedding
# model + corpus, measure retrieval quality, iterate.
def _clamp_weight(env_key: str, default: float) -> float:
    try:
        v = float(os.getenv(env_key, str(default)))
    except ValueError:
        logger.warn("invalid_weight_env", key=env_key, value=os.getenv(env_key))
        return default
    return max(0.0, min(1.0, v))


VECTOR_WEIGHT = _clamp_weight("RETRIEVAL_VECTOR_WEIGHT", 0.7)
KEYWORD_WEIGHT = _clamp_weight("RETRIEVAL_KEYWORD_WEIGHT", 0.3)

# Distance threshold for vector-only matches (no keyword match)
# Higher = more permissive. bge-m3 distances tend to be larger than OpenAI's.
MAX_VECTOR_DISTANCE = _clamp_weight("RETRIEVAL_MAX_VECTOR_DISTANCE", 0.8)


# Two-stage retrieval: the HNSW index on c.embedding answers
# `ORDER BY embedding <=> $1 LIMIT N` in O(log n) with ef_search quality,
# but `ts_rank(...)` can't use the index — it scans whatever rows come in.
# Stage 1 prunes to the CANDIDATE_POOL nearest vector matches (cheap), then
# stage 2 re-ranks that pool with the hybrid score (expensive but bounded).
# For corpora >>1k chunks this swaps an O(n) ts_rank over the whole table
# for a ranker over CANDIDATE_POOL rows. Small corpora run both stages
# anyway — cost is negligible.
CANDIDATE_POOL = int(os.getenv("RETRIEVAL_CANDIDATE_POOL", "100"))


def retrieve_chunks(
    query: str,
    paper_ids: list[str] | None = None,
    top_k: int = 20,
) -> list[dict[str, object]]:
    """Retrieve top-k relevant chunks via two-stage hybrid search.

    Stage 1: vector-nearest CANDIDATE_POOL chunks via HNSW.
    Stage 2: re-rank those candidates with the hybrid vector + BM25 score.
    """
    logger.info("retrieval_start", query=query[:100], paper_ids=paper_ids, top_k=top_k)

    # Generate query embedding
    query_embedding = embed_single_sync(query)
    embedding_str = "[" + ",".join(str(x) for x in query_embedding) + "]"

    # Stage 1 + stage 2 are one SQL statement — the candidate CTE is
    # bounded by CANDIDATE_POOL and re-ranked in the outer query. Simpler
    # than two round-trips and lets the planner pick the HNSW index.
    if paper_ids:
        placeholders = ",".join(f"${i+4}" for i in range(len(paper_ids)))
        paper_filter = f"AND c.paper_id IN ({placeholders})"
        args: list[object] = [embedding_str, query, CANDIDATE_POOL, *paper_ids, top_k]
    else:
        paper_filter = ""
        args = [embedding_str, query, CANDIDATE_POOL, top_k]

    top_k_param = f"${len(args)}"

    sql = f"""
    WITH candidates AS (
        -- Stage 1: nearest CANDIDATE_POOL by vector alone. Uses HNSW index.
        SELECT c.id
        FROM chunks c
        WHERE TRUE {paper_filter.replace('c.paper_id', 'c.paper_id')}
        ORDER BY c.embedding <=> $1::vector
        LIMIT $3
    )
    -- Stage 2: hybrid re-rank over the candidates + any additional pure-keyword
    -- matches (UNION) so a rare-term query with a weak vector signal still
    -- surfaces its keyword hits.
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
        c.id IN (SELECT id FROM candidates)
        OR c.search_vector @@ plainto_tsquery('english', $2)
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
        # Boost scores for chunks from papers the user has liked posts about.
        # Match on normalized full title — bidirectional substring matching
        # (a `in` b OR b `in` a) produces false positives like "Nature" lighting
        # up on any journal name that happens to contain the word.
        liked_set = {t.strip().lower() for t in liked_paper_titles if t}
        for chunk in results:
            title = (chunk.get("paper_title") or "").strip().lower()
            if title and title in liked_set:
                chunk["score"] = chunk["score"] * LIKED_PAPER_BOOST
                chunk["boosted"] = True

        # Re-sort by score and take top_k
        results.sort(key=lambda c: c["score"], reverse=True)
        results = results[:top_k]

    return results


# Score multiplier for chunks from papers the user has liked posts about
LIKED_PAPER_BOOST = 1.25
