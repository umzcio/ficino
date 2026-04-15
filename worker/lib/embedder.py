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

logger = structlog.get_logger(__name__)


def _get_embed_config() -> dict[str, str]:
    """Read embed config from env at call time (supports runtime changes)."""
    return {
        "provider": os.getenv("EMBED_PROVIDER", "ollama"),
        "ollama_base_url": os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434"),
        "ollama_model": os.getenv("OLLAMA_EMBED_MODEL", "bge-m3:latest"),
        "openai_api_key": os.getenv("OPENAI_API_KEY", ""),
        "openai_model": os.getenv("OPENAI_EMBED_MODEL", "text-embedding-3-small"),
        "voyage_api_key": os.getenv("VOYAGE_API_KEY", ""),
        "voyage_model": os.getenv("VOYAGE_EMBED_MODEL", "voyage-4-large"),
    }


BATCH_SIZE = 100


async def _embed_ollama(texts: list[str]) -> list[list[float]]:
    """Generate embeddings using Ollama."""
    cfg = _get_embed_config()
    embeddings: list[list[float]] = []
    async with httpx.AsyncClient(timeout=120.0) as client:
        for i, text in enumerate(texts):
            if i % 10 == 0:
                logger.info("ollama_embedding", progress=f"{i}/{len(texts)}")
            resp = await client.post(
                f"{cfg['ollama_base_url']}/api/embeddings",
                json={"model": cfg["ollama_model"], "prompt": text},
            )
            resp.raise_for_status()
            embeddings.append(resp.json()["embedding"])
    return embeddings


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
        logger.warn("no_embed_provider_available", provider=provider)
        dim = int(os.getenv("EMBED_DIM", "1024"))
        result = [[0.0] * dim for _ in texts]

    logger.info("embedding_complete", count=len(result), dim=len(result[0]) if result else 0)
    return result


async def embed_single(text: str, *, input_type: str = "document") -> list[float]:
    """Generate embedding for a single text."""
    results = await embed_texts([text], input_type=input_type)
    return results[0]


def embed_texts_sync(texts: list[str], *, input_type: str = "document") -> list[list[float]]:
    """Synchronous wrapper for use in Celery tasks."""
    return asyncio.run(embed_texts(texts, input_type=input_type))


def embed_single_sync(text: str, *, input_type: str = "query") -> list[float]:
    """Synchronous wrapper for use in Celery tasks.

    Defaults to 'query' since embed_single_sync is used for retrieval.
    """
    return asyncio.run(embed_single(text, input_type=input_type))
