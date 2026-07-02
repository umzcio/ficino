"""Contextual retrieval — generate a 1-2 sentence prefix per chunk.

Anthropic's contextual retrieval technique: before embedding, prepend a
short blurb that situates each chunk inside its source paper
("This chunk from 'Paper X' discusses the ablation on ..."). The
contextualized chunk embeds + keyword-searches more reliably because
the pronouns, section names, and deictic references ("this method",
"the authors") now carry their referent in-line.

Providers selected via CONTEXT_PROVIDER setting:
  - "none":      passthrough, returns empty strings
  - "ollama":    local qwen3.5, no prompt caching, paper re-sent per chunk
  - "anthropic": Claude Haiku with prompt caching — paper is cached once
                 per paper, each chunk call pays ~100 output tokens only

The Anthropic path is the cost-critical one. With ephemeral prompt caching
a 50k-token paper costs ~1¢ to cache once + fractions of a cent per chunk.
Without caching the same paper would be re-sent 100+ times, multiplying
input-token cost ~100×. If you run on Anthropic without the cache block
below you will set money on fire.
"""

import asyncio
import os

import httpx
import structlog

from lib.event_loop import LoopRunner
from lib.settings import get_active, ollama_base_url

logger = structlog.get_logger(__name__)


def _get_context_config() -> dict[str, str]:
    """Read contextualizer config from active provider settings / env."""
    return {
        "provider": get_active("context_provider", "CONTEXT_PROVIDER", "none"),
        "ollama_base_url": ollama_base_url(),
        "ollama_model": get_active("context_ollama_model", "CONTEXT_OLLAMA_MODEL", "qwen3.5:latest"),
        "anthropic_model": get_active("context_anthropic_model", "CONTEXT_ANTHROPIC_MODEL", "claude-haiku-4-5"),
        "anthropic_api_key": get_active("anthropic_api_key", "ANTHROPIC_API_KEY", ""),
    }


# Hard cap on how much of the paper we hand to the contextualizer. A
# full textbook won't fit a model's context window and would blow up
# cache cost. Truncation is acceptable — the contextual prefix only
# needs enough surrounding material to situate the chunk.
MAX_PAPER_CHARS = int(os.getenv("CONTEXT_MAX_PAPER_CHARS", "200000"))

# Per-chunk output budget. We want a 1-2 sentence blurb, not a summary.
MAX_CONTEXT_TOKENS = int(os.getenv("CONTEXT_MAX_TOKENS", "150"))


SYSTEM_PROMPT = (
    "You situate a short excerpt inside its source academic paper. "
    "You write one or two concise sentences (<=50 words total) that say "
    "what the excerpt is about and where it fits in the paper. "
    "Do NOT quote the excerpt. Do NOT begin with 'This chunk' or 'The excerpt'. "
    "Write plain prose a human could read as a prefix before the excerpt. "
    "Output only the sentences, no preamble."
)


def _build_user_prompt(paper_text: str, chunk_content: str) -> str:
    """Build the per-chunk prompt. Paper text is truncated up front."""
    paper = paper_text[:MAX_PAPER_CHARS]
    return (
        f"<paper>\n{paper}\n</paper>\n\n"
        f"<excerpt>\n{chunk_content}\n</excerpt>\n\n"
        "Write the contextual prefix for the excerpt."
    )


async def _context_ollama(paper_text: str, chunks: list[dict[str, object]]) -> list[str]:
    """Ollama path. No prompt caching, so each chunk re-sends the paper.

    Slow but free. Run serially to avoid spiking a shared GPU — parallel
    contextualization across chunks would serialize at the model anyway
    on typical single-GPU Ollama deployments and just add queueing.
    """
    cfg = _get_context_config()
    results: list[str] = []
    async with httpx.AsyncClient(timeout=300.0) as client:
        for chunk in chunks:
            user = _build_user_prompt(paper_text, str(chunk.get("content", "")))
            payload = {
                "model": cfg["ollama_model"],
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user},
                ],
                "stream": False,
                "think": False,
                "options": {"temperature": 0.2, "num_predict": MAX_CONTEXT_TOKENS},
            }
            try:
                resp = await client.post(
                    f"{cfg['ollama_base_url']}/api/chat", json=payload,
                )
                resp.raise_for_status()
                msg = resp.json()["message"]
                content = (msg.get("content") or msg.get("thinking") or "").strip()
                results.append(content)
            except Exception as e:
                # Prefix is best-effort. If a single chunk fails, the rest
                # should still get their prefix rather than the whole paper
                # re-ingesting with zero prefixes.
                logger.warn("context_ollama_chunk_failed", error=str(e)[:200])
                results.append("")
    return results


async def _context_anthropic(paper_text: str, chunks: list[dict[str, object]]) -> list[str]:
    """Anthropic path with ephemeral prompt caching.

    The paper goes in a `cache_control: {"type": "ephemeral"}` content
    block on the system message. The first call writes the cache (pay
    full input), every subsequent call within 5 minutes reads from the
    cache (10% of input cost). Doing all chunks back-to-back keeps the
    window warm.

    We fire the chunk calls in parallel (bounded) rather than serially:
    the cache hit is cheap and Claude API is multi-tenant; parallelism
    here shortens wall-clock for a 100-chunk paper from minutes to
    seconds.
    """
    import anthropic

    cfg = _get_context_config()
    client = anthropic.AsyncAnthropic(api_key=cfg["anthropic_api_key"])
    paper = paper_text[:MAX_PAPER_CHARS]

    system_blocks = [
        # Short instruction block — NOT cached. Small and cheap; caching
        # adds a min-size constraint that a 50-token prompt wouldn't hit.
        {"type": "text", "text": SYSTEM_PROMPT},
        # The paper itself — cached. This is the block that pays off.
        {
            "type": "text",
            "text": f"<paper>\n{paper}\n</paper>",
            "cache_control": {"type": "ephemeral"},
        },
    ]

    sem = asyncio.Semaphore(8)

    async def one(chunk: dict[str, object]) -> str:
        user = (
            f"<excerpt>\n{chunk.get('content', '')}\n</excerpt>\n\n"
            "Write the contextual prefix for the excerpt."
        )
        async with sem:
            try:
                resp = await client.messages.create(
                    model=cfg["anthropic_model"],
                    max_tokens=MAX_CONTEXT_TOKENS,
                    temperature=0.2,
                    system=system_blocks,
                    messages=[{"role": "user", "content": user}],
                )
                # Defensive: model could in principle return non-text
                # blocks (tool_use, thinking). Concatenate all text parts.
                parts = [b.text for b in resp.content if getattr(b, "type", None) == "text"]
                return "".join(parts).strip()
            except Exception as e:
                logger.warn("context_anthropic_chunk_failed", error=str(e)[:200])
                return ""

    return await asyncio.gather(*[one(c) for c in chunks])


async def generate_contexts_for_paper(
    paper_text: str,
    chunks: list[dict[str, object]],
) -> list[str]:
    """Generate a contextual prefix per chunk for one paper.

    Returns a list aligned 1:1 with `chunks`. Empty strings represent
    "no prefix" (either provider=none, a per-chunk failure, or a trimmed
    paper that yielded nothing useful).

    Batching is per-paper because that's the natural scope for the
    Anthropic prompt cache: one paper -> one cached block -> many chunk
    calls that all hit the cache. Cross-paper batching would miss-cache
    on every call.
    """
    if not chunks:
        return []

    cfg = _get_context_config()
    provider = cfg["provider"]
    logger.info(
        "context_generation_start",
        provider=provider,
        chunks=len(chunks),
        paper_chars=len(paper_text),
    )

    if provider == "none":
        return ["" for _ in chunks]

    if provider == "ollama":
        return await _context_ollama(paper_text, chunks)

    if provider == "anthropic":
        if not cfg["anthropic_api_key"]:
            logger.error("context_anthropic_no_api_key", provider=provider)
            return ["" for _ in chunks]
        return await _context_anthropic(paper_text, chunks)

    logger.warn("context_unknown_provider", provider=provider)
    return ["" for _ in chunks]


# Sync wrapper using the shared background-loop helper (R10 DUP-5:
# LoopRunner) — `asyncio.run()` per call tears down httpx pools and stacks
# poorly with Celery's loop handling.
_runner = LoopRunner("context-loop")


def generate_contexts_for_paper_sync(
    paper_text: str,
    chunks: list[dict[str, object]],
) -> list[str]:
    """Synchronous wrapper for use in Celery tasks."""
    return _runner.run(generate_contexts_for_paper(paper_text, chunks))
