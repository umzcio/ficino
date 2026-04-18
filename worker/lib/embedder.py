"""Text embedding generation — supports Ollama, OpenAI, and Voyage AI.

Provider is selected via EMBED_PROVIDER setting:
  - "ollama": uses local Ollama (default, free)
  - "openai": uses OpenAI (model configurable via OPENAI_EMBED_MODEL)
  - "voyage": uses Voyage AI (model configurable via VOYAGE_EMBED_MODEL, default voyage-4-large)
"""

import asyncio
import os

import httpx
import structlog

from lib.settings import get_active

logger = structlog.get_logger(__name__)


def _get_embed_config() -> dict[str, str]:
    """Read embed config from active provider settings, falling back to env."""
    return {
        "provider": get_active("embed_provider", "EMBED_PROVIDER", "ollama"),
        # ollama_base_url is env-only (SSRF defense).
        "ollama_base_url": os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434"),
        "ollama_model": get_active("ollama_embed_model", "OLLAMA_EMBED_MODEL", "bge-m3:latest"),
        "openai_api_key": get_active("openai_api_key", "OPENAI_API_KEY", ""),
        "openai_model": get_active("openai_embed_model", "OPENAI_EMBED_MODEL", "text-embedding-3-small"),
        "voyage_api_key": get_active("voyage_api_key", "VOYAGE_API_KEY", ""),
        "voyage_model": get_active("voyage_embed_model", "VOYAGE_EMBED_MODEL", "voyage-4-large"),
    }


BATCH_SIZE = 100


async def _embed_ollama(texts: list[str]) -> list[list[float]]:
    """Generate embeddings using Ollama with a bounded concurrency pool.

    Serial per-text POSTs underutilize Ollama, which can batch reasonably well
    on its side. An 8-way semaphore parallelizes the HTTP calls while keeping
    the load modest enough to avoid crushing a shared GPU.
    """
    cfg = _get_embed_config()
    sem = asyncio.Semaphore(8)
    completed = 0
    total = len(texts)
    progress_lock = asyncio.Lock()

    async with httpx.AsyncClient(timeout=120.0) as client:
        async def one(text: str) -> list[float]:
            nonlocal completed
            async with sem:
                resp = await client.post(
                    f"{cfg['ollama_base_url']}/api/embeddings",
                    json={"model": cfg["ollama_model"], "prompt": text},
                )
                resp.raise_for_status()
                embedding = resp.json()["embedding"]
            # Log progress outside the semaphore so it doesn't serialize.
            async with progress_lock:
                completed += 1
                if completed % 10 == 0 or completed == total:
                    logger.info("ollama_embedding", progress=f"{completed}/{total}")
            return embedding

        return await asyncio.gather(*[one(t) for t in texts])


async def _embed_openai(texts: list[str]) -> list[list[float]]:
    """Generate embeddings using OpenAI API."""
    import openai
    cfg = _get_embed_config()
    client = openai.AsyncOpenAI(api_key=cfg["openai_api_key"])
    all_embeddings: list[list[float]] = []

    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i:i + BATCH_SIZE]
        logger.info("openai_embedding_batch", start=i, count=len(batch))
        response = await client.embeddings.create(model=cfg["openai_model"], input=batch)
        all_embeddings.extend([item.embedding for item in response.data])
        # Throttle between batches so a 10k-chunk ingestion doesn't burst
        # past OpenAI's TPM / RPM caps. Mirrors the Voyage pattern above.
        if i + BATCH_SIZE < len(texts):
            await asyncio.sleep(1.0)

    return all_embeddings


async def _embed_voyage(texts: list[str], input_type: str = "document") -> list[list[float]]:
    """Generate embeddings using Voyage AI API.

    input_type: "document" for ingestion, "query" for retrieval.
    """
    import asyncio as _asyncio

    cfg = _get_embed_config()
    all_embeddings: list[list[float]] = []

    # Tier 1: 300 RPM / 1M TPM — batch 128 chunks, minimal delay
    voyage_batch = 128

    async with httpx.AsyncClient(timeout=120.0) as client:
        for i in range(0, len(texts), voyage_batch):
            batch = texts[i:i + voyage_batch]
            logger.info("voyage_embedding_batch", start=i, count=len(batch), total=len(texts))

            for attempt in range(5):
                resp = await client.post(
                    "https://api.voyageai.com/v1/embeddings",
                    headers={
                        "Authorization": f"Bearer {cfg['voyage_api_key']}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "input": batch,
                        "model": cfg["voyage_model"],
                        "input_type": input_type,
                        "output_dimension": int(os.getenv("EMBED_DIM", "1024")),
                    },
                )
                if resp.status_code == 429:
                    wait = 20 * (attempt + 1)
                    logger.warn("voyage_rate_limited", attempt=attempt + 1, wait=wait)
                    await _asyncio.sleep(wait)
                    continue
                resp.raise_for_status()
                data = resp.json()["data"]
                all_embeddings.extend([item["embedding"] for item in data])
                break
            else:
                resp.raise_for_status()

            # Brief pause between batches to stay under 300 RPM
            if i + voyage_batch < len(texts):
                await _asyncio.sleep(0.5)

    return all_embeddings


async def embed_texts(texts: list[str], *, input_type: str = "document") -> list[list[float]]:
    """Generate embeddings using the configured provider.

    input_type: "document" for ingestion, "query" for retrieval (only affects Voyage).
    Returns list of float vectors (dimension depends on model/config, default 1024).
    """
    if not texts:
        return []

    cfg = _get_embed_config()
    provider = cfg["provider"]
    logger.info("embedding_start", provider=provider, count=len(texts))

    if provider == "ollama":
        result = await _embed_ollama(texts)
    elif provider == "openai" and cfg["openai_api_key"]:
        result = await _embed_openai(texts)
    elif provider == "voyage" and cfg["voyage_api_key"]:
        result = await _embed_voyage(texts, input_type=input_type)
    else:
        # Silent zero-vector fallback poisons HNSW with meaningless neighbors.
        # Raise a clear error so upstream tasks can mark papers 'error' with
        # a descriptive reason instead of storing garbage retrieval indexes.
        reason = (
            f"provider={provider!r}, "
            f"openai_key={'set' if cfg['openai_api_key'] else 'missing'}, "
            f"voyage_key={'set' if cfg['voyage_api_key'] else 'missing'}"
        )
        logger.error("no_embed_provider_available", provider=provider, reason=reason)
        raise RuntimeError(f"No embedding provider reachable: {reason}")

    logger.info("embedding_complete", count=len(result), dim=len(result[0]) if result else 0)
    return result


async def embed_single(text: str, *, input_type: str = "document") -> list[float]:
    """Generate embedding for a single text."""
    results = await embed_texts([text], input_type=input_type)
    return results[0]


# Shared persistent event loop for the embedder's sync wrappers — `asyncio.run()`
# creates a fresh loop on every call, which (a) tears down httpx's internal
# connection pool each time and (b) stacks ominously with Celery's own
# loop-lifecycle management. One long-lived loop + a thread lock matches the
# pattern already used in lib/db.py.
#
# Round-4: loop runs on a dedicated daemon thread via run_forever, so
# multiple Celery worker threads that hit embed_single_sync concurrently
# don't serialize on a single run_until_complete. The inner asyncio.gather
# and Voyage batching already provide the concurrency — the previous lock
# squashed it.
import threading

_embed_loop: asyncio.AbstractEventLoop | None = None
_embed_loop_lock = threading.Lock()


def _ensure_embed_loop() -> asyncio.AbstractEventLoop:
    global _embed_loop
    if _embed_loop is not None and not _embed_loop.is_closed():
        return _embed_loop
    with _embed_loop_lock:
        if _embed_loop is None or _embed_loop.is_closed():
            loop = asyncio.new_event_loop()

            def _runner() -> None:
                asyncio.set_event_loop(loop)
                loop.run_forever()

            t = threading.Thread(target=_runner, name="embed-loop", daemon=True)
            t.start()
            _embed_loop = loop
        return _embed_loop


def _run_on_embed_loop(coro):
    """Execute an async coroutine on the embedder's persistent loop."""
    loop = _ensure_embed_loop()
    return asyncio.run_coroutine_threadsafe(coro, loop).result()


def embed_texts_sync(texts: list[str], *, input_type: str = "document") -> list[list[float]]:
    """Synchronous wrapper for use in Celery tasks."""
    return _run_on_embed_loop(embed_texts(texts, input_type=input_type))


def embed_single_sync(text: str, *, input_type: str = "query") -> list[float]:
    """Synchronous wrapper for use in Celery tasks.

    Defaults to 'query' since embed_single_sync is used for retrieval.
    """
    return _run_on_embed_loop(embed_single(text, input_type=input_type))
