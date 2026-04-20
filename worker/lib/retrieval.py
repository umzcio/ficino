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
from lib.reranker import rerank as rerank_chunks

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

# When a reranker is enabled, fetch this multiple of top_k from SQL so the
# cross-encoder has enough candidates to meaningfully reorder. Capped at
# CANDIDATE_POOL so we never exceed the stage-1 bound.
RERANK_MULTIPLIER = int(os.getenv("RETRIEVAL_RERANK_MULTIPLIER", "5"))


def retrieve_chunks(
    query: str,
    paper_ids: list[str] | None = None,
    top_k: int = 20,
    query_embedding: list[float] | None = None,
) -> list[dict[str, object]]:
    """Retrieve top-k relevant chunks via two-stage hybrid search.

    Stage 1: vector-nearest CANDIDATE_POOL chunks via HNSW.
    Stage 2: re-rank those candidates with the hybrid vector + BM25 score.
    Stage 3 (optional): cross-encoder reranker over top top_k*RERANK_MULTIPLIER.

    If `query_embedding` is provided, skip the per-call embed_single_sync
    hop — feed generation batches all persona retrieval queries through
    embed_texts_sync once and passes the precomputed vectors in here.
    """
    logger.info("retrieval_start", query=query[:100], paper_ids=paper_ids, top_k=top_k)

    # If a reranker is configured, pull a wider slice from SQL so the
    # cross-encoder has enough material to reorder meaningfully. Capped at
    # CANDIDATE_POOL — the stage-1 branch can't return more than it fetched.
    rerank_provider = os.getenv("RERANK_PROVIDER", "none")
    sql_top_k = top_k
    if rerank_provider != "none":
        sql_top_k = min(CANDIDATE_POOL, max(top_k * RERANK_MULTIPLIER, top_k))

    # Generate query embedding if the caller didn't precompute one.
    if query_embedding is None:
        query_embedding = embed_single_sync(query)
    embedding_str = "[" + ",".join(str(x) for x in query_embedding) + "]"

    # Stage 1 + stage 2 are one SQL statement — the candidate CTE is
    # bounded by CANDIDATE_POOL and re-ranked in the outer query. Simpler
    # than two round-trips and lets the planner pick the HNSW index.
    if paper_ids:
        placeholders = ",".join(f"${i+4}" for i in range(len(paper_ids)))
        paper_filter = f"AND c.paper_id IN ({placeholders})"
        args: list[object] = [embedding_str, query, CANDIDATE_POOL, *paper_ids, sql_top_k]
    else:
        paper_filter = ""
        args = [embedding_str, query, CANDIDATE_POOL, sql_top_k]

    top_k_param = f"${len(args)}"

    sql = f"""
    WITH candidates AS (
        -- Stage 1a: nearest CANDIDATE_POOL by vector alone. Uses HNSW index.
        SELECT c.id
        FROM chunks c
        WHERE TRUE {paper_filter}
        ORDER BY c.embedding <=> $1::vector
        LIMIT $3
    ),
    keyword_hits AS (
        -- Stage 1b: top-CANDIDATE_POOL pure keyword hits, bounded the same way
        -- as the vector branch. The original WHERE clause had an unbounded
        -- `OR c.search_vector @@ plainto_tsquery(...)` that degenerated to a
        -- full-table scan on large corpora and pulled thousands of weak
        -- keyword matches into the re-ranker. Bounding + ordering by ts_rank
        -- keeps Stage 2 proportional to CANDIDATE_POOL.
        SELECT c.id
        FROM chunks c
        WHERE c.search_vector @@ plainto_tsquery('english', $2) {paper_filter}
        ORDER BY ts_rank(c.search_vector, plainto_tsquery('english', $2)) DESC
        LIMIT $3
    )
    -- Stage 2: hybrid re-rank over the bounded union of candidates + keyword_hits.
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
        OR c.id IN (SELECT id FROM keyword_hits)
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

    # Stage 3: cross-encoder rerank, if enabled. No-ops when RERANK_PROVIDER
    # is "none" (default) so this is a safe ship without flipping any flag.
    if rerank_provider != "none" and results:
        reranked = rerank_chunks(query, results, top_k=top_k)
        logger.info("retrieval_reranked",
                    provider=rerank_provider,
                    input=len(results), output=len(reranked))
        return reranked

    return results


def _get_retrieval_queries() -> dict[str, str]:
    """Return {persona_key → retrieval_query} from the personas cache.

    Was previously cached in a module-level dict with no TTL and no
    invalidate hook, which meant retrieval_query edits via admin SQL
    never surfaced without a worker restart. `persona_lib.get_personas()`
    already has a 1h TTL + `invalidate_personas_cache()` — piggyback on
    that instead of maintaining a parallel cache.
    """
    from lib import persona as persona_lib  # local import avoids circular at import time

    personas = persona_lib.get_personas()
    return {
        key: (p.get("retrieval_query") or "key findings and methodology")
        for key, p in personas.items()
    }


def retrieve_for_persona(
    persona_key: str,
    paper_ids: list[str] | None = None,
    top_k: int = 10,
    liked_paper_titles: list[str] | None = None,
    query_embedding: list[float] | None = None,
) -> list[dict[str, object]]:
    """Retrieve chunks tailored for a specific persona's focus area.

    Each persona has a preferred section focus that influences the query.
    If liked_paper_titles is provided (from Phase 3 training signal),
    chunks from those papers get a score boost so they surface more often.

    Callers that fan out over multiple personas should batch-embed all
    queries via embed_texts_sync once and pass each persona's vector in
    `query_embedding` to skip redundant per-persona embedding RTT.
    """
    queries = _get_retrieval_queries()
    query = queries.get(persona_key, "key findings and methodology")
    results = retrieve_chunks(
        query,
        paper_ids=paper_ids,
        top_k=top_k * 2 if liked_paper_titles else top_k,
        query_embedding=query_embedding,
    )

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
