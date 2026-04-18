"""Cross-encoder reranking of retrieval candidates.

Supports four providers, selected via RERANK_PROVIDER setting:
  - "none":   passthrough (ablation / disable)
  - "local":  BAAI/bge-reranker-v2-m3 via sentence-transformers, in-process
  - "voyage": Voyage AI rerank-2-lite / rerank-2
  - "cohere": Cohere rerank-v3.5

Called AFTER the hybrid SQL retrieval has narrowed the corpus to a
candidate pool. The reranker re-scores (query, chunk.content) pairs
with a cross-encoder, which sees both texts together and so captures
query-dependent relevance a bi-encoder (embedder) structurally cannot.

Typical quality lift: reorder top_k × multiplier → top_k.
Typical latency: 50-300ms for 100 candidates (local), 50-200ms (hosted).
"""

import os
import threading

import httpx
import structlog

from lib.settings import get_active

logger = structlog.get_logger(__name__)


def _get_rerank_config() -> dict[str, str]:
    """Read rerank config from active provider settings, falling back to env."""
    return {
        "provider": get_active("rerank_provider", "RERANK_PROVIDER", "none"),
        "local_model": get_active("rerank_local_model", "RERANK_LOCAL_MODEL", "BAAI/bge-reranker-v2-m3"),
        "voyage_api_key": get_active("voyage_api_key", "VOYAGE_API_KEY", ""),
        "voyage_model": get_active("rerank_voyage_model", "RERANK_VOYAGE_MODEL", "rerank-2-lite"),
        "cohere_api_key": get_active("cohere_api_key", "COHERE_API_KEY", ""),
        "cohere_model": get_active("rerank_cohere_model", "RERANK_COHERE_MODEL", "rerank-v3.5"),
    }


# Cross-encoder is a heavy object (model weights, ~500MB for bge-reranker-v2-m3).
# Load once per worker process and reuse across queries — loading on every call
# would dominate latency and exhaust RAM. Thread lock guards first-load race
# under Celery's prefork+thread pools.
_local_model = None
_local_model_lock = threading.Lock()


def _get_local_model():
    """Lazy-load the local cross-encoder. Singleton per process."""
    global _local_model
    if _local_model is not None:
        return _local_model
    with _local_model_lock:
        if _local_model is None:
            cfg = _get_rerank_config()
            # Import inside the function so that a worker that never uses the
            # local provider (e.g. voyage-only prod) doesn't pay the
            # sentence-transformers/torch import cost at module load.
            from sentence_transformers import CrossEncoder
            logger.info("rerank_local_loading", model=cfg["local_model"])
            _local_model = CrossEncoder(cfg["local_model"])
            logger.info("rerank_local_loaded", model=cfg["local_model"])
        return _local_model


def _rerank_local(query: str, chunks: list[dict[str, object]]) -> list[dict[str, object]]:
    """Score (query, chunk.content) pairs with a local cross-encoder."""
    model = _get_local_model()
    pairs = [(query, str(c.get("content", ""))) for c in chunks]
    # CrossEncoder.predict returns raw logits — larger = more relevant.
    # Shape: (n,). Convert to Python floats for JSON/DB friendliness.
    scores = model.predict(pairs, show_progress_bar=False)
    for chunk, score in zip(chunks, scores):
        chunk["rerank_score"] = float(score)
    return chunks


def _rerank_voyage(query: str, chunks: list[dict[str, object]]) -> list[dict[str, object]]:
    """Score candidates with Voyage's hosted rerank endpoint."""
    cfg = _get_rerank_config()
    if not cfg["voyage_api_key"]:
        logger.warn("rerank_voyage_no_api_key_passthrough")
        return chunks

    documents = [str(c.get("content", "")) for c in chunks]
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(
            "https://api.voyageai.com/v1/rerank",
            headers={
                "Authorization": f"Bearer {cfg['voyage_api_key']}",
                "Content-Type": "application/json",
            },
            json={
                "query": query,
                "documents": documents,
                "model": cfg["voyage_model"],
                "top_k": len(documents),  # get scores for all; caller slices
            },
        )
        resp.raise_for_status()
        data = resp.json()["data"]

    # Voyage returns items with `index` referring to original position +
    # `relevance_score`. Map back onto the input list.
    for item in data:
        idx = item.get("index")
        if idx is None or idx >= len(chunks):
            continue
        chunks[idx]["rerank_score"] = float(item["relevance_score"])
    return chunks


def _rerank_cohere(query: str, chunks: list[dict[str, object]]) -> list[dict[str, object]]:
    """Score candidates with Cohere's hosted rerank endpoint."""
    cfg = _get_rerank_config()
    if not cfg["cohere_api_key"]:
        logger.warn("rerank_cohere_no_api_key_passthrough")
        return chunks

    documents = [str(c.get("content", "")) for c in chunks]
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(
            "https://api.cohere.com/v2/rerank",
            headers={
                "Authorization": f"Bearer {cfg['cohere_api_key']}",
                "Content-Type": "application/json",
            },
            json={
                "query": query,
                "documents": documents,
                "model": cfg["cohere_model"],
                "top_n": len(documents),
            },
        )
        resp.raise_for_status()
        results = resp.json()["results"]

    for item in results:
        idx = item.get("index")
        if idx is None or idx >= len(chunks):
            continue
        chunks[idx]["rerank_score"] = float(item["relevance_score"])
    return chunks


def rerank(
    query: str,
    chunks: list[dict[str, object]],
    top_k: int | None = None,
) -> list[dict[str, object]]:
    """Rerank `chunks` against `query` and return the top_k by rerank_score.

    Passthrough when provider is "none" or the candidate list is trivially
    short (< 2). On provider error, falls back to the input ordering rather
    than raising — retrieval should degrade gracefully.
    """
    if not chunks:
        return chunks
    if top_k is None:
        top_k = len(chunks)

    cfg = _get_rerank_config()
    provider = cfg["provider"]

    if provider == "none" or len(chunks) < 2:
        return chunks[:top_k]

    try:
        if provider == "local":
            scored = _rerank_local(query, chunks)
        elif provider == "voyage":
            scored = _rerank_voyage(query, chunks)
        elif provider == "cohere":
            scored = _rerank_cohere(query, chunks)
        else:
            logger.warn("rerank_unknown_provider_passthrough", provider=provider)
            return chunks[:top_k]
    except Exception as e:
        # Don't take down retrieval for a rerank outage. Log and degrade to
        # the input ordering, which is already the hybrid-score ordering
        # from the SQL stage — a worse result than reranked, but a fine
        # fallback.
        logger.warn("rerank_failed_passthrough", provider=provider, error=str(e)[:200])
        return chunks[:top_k]

    # Chunks without a rerank_score (provider dropped them / API returned
    # fewer results than inputs) keep their original hybrid score as a
    # tiebreaker floor below anything the reranker actually saw.
    def _sort_key(c: dict[str, object]) -> float:
        rs = c.get("rerank_score")
        if rs is None:
            # Sentinel: unranked items fall below any real rerank score
            return float("-inf")
        return float(rs)

    scored.sort(key=_sort_key, reverse=True)
    return scored[:top_k]
