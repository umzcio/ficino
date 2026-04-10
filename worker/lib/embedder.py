"""Text embedding generation — supports OpenAI API and Ollama.

Provider is selected via EMBED_PROVIDER env var:
  - "ollama": uses local Ollama (default, free)
  - "api": uses OpenAI text-embedding-3-small
"""

import asyncio
import os

import httpx
import structlog

logger = structlog.get_logger(__name__)

EMBED_PROVIDER = os.getenv("EMBED_PROVIDER", "ollama")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434")
OLLAMA_EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "mxbai-embed-large:latest")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = "text-embedding-3-small"
BATCH_SIZE = 100


async def _embed_ollama(texts: list[str]) -> list[list[float]]:
    """Generate embeddings using Ollama."""
    embeddings: list[list[float]] = []
    async with httpx.AsyncClient(timeout=120.0) as client:
        for i, text in enumerate(texts):
            if i % 10 == 0:
                logger.info("ollama_embedding", progress=f"{i}/{len(texts)}")
            resp = await client.post(
                f"{OLLAMA_BASE_URL}/api/embeddings",
                json={"model": OLLAMA_EMBED_MODEL, "prompt": text},
            )
            resp.raise_for_status()
            embeddings.append(resp.json()["embedding"])
    return embeddings


async def _embed_openai(texts: list[str]) -> list[list[float]]:
    """Generate embeddings using OpenAI API."""
    import openai
    client = openai.AsyncOpenAI(api_key=OPENAI_API_KEY)
    all_embeddings: list[list[float]] = []

    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i:i + BATCH_SIZE]
        logger.info("openai_embedding_batch", start=i, count=len(batch))
        response = await client.embeddings.create(model=OPENAI_MODEL, input=batch)
        all_embeddings.extend([item.embedding for item in response.data])

    return all_embeddings


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """Generate embeddings using the configured provider.

    Returns list of float vectors (dimension depends on model:
    1024 for mxbai-embed-large, 768 for nomic-embed-text, 1536 for OpenAI).
    """
    if not texts:
        return []

    logger.info("embedding_start", provider=EMBED_PROVIDER, count=len(texts))

    if EMBED_PROVIDER == "ollama":
        result = await _embed_ollama(texts)
    elif EMBED_PROVIDER == "api" and OPENAI_API_KEY:
        result = await _embed_openai(texts)
    else:
        logger.warn("no_embed_provider_available", provider=EMBED_PROVIDER)
        dim = int(os.getenv("EMBED_DIM", "1024"))
        result = [[0.0] * dim for _ in texts]

    logger.info("embedding_complete", count=len(result), dim=len(result[0]) if result else 0)
    return result


async def embed_single(text: str) -> list[float]:
    """Generate embedding for a single text."""
    results = await embed_texts([text])
    return results[0]


def embed_texts_sync(texts: list[str]) -> list[list[float]]:
    """Synchronous wrapper for use in Celery tasks."""
    return asyncio.run(embed_texts(texts))


def embed_single_sync(text: str) -> list[float]:
    """Synchronous wrapper for use in Celery tasks."""
    return asyncio.run(embed_single(text))
