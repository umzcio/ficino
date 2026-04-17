"""LLM client for persona post generation and contradiction classification.

Supports both Claude API and Ollama as providers.
Provider is selected via LLM_PROVIDER env var:
  - "ollama": uses local Ollama (default, free)
  - "api": uses Anthropic Claude API
"""

import asyncio
import json
import os

import httpx
import structlog

logger = structlog.get_logger(__name__)

def _get_config() -> dict[str, str]:
    """Read LLM config from env at call time (supports runtime changes)."""
    return {
        "llm_provider": os.getenv("LLM_PROVIDER", "ollama"),
        "ollama_base_url": os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434"),
        "ollama_llm_model": os.getenv("OLLAMA_LLM_MODEL", "qwen3.5:latest"),
        "claude_model": os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6"),
        "anthropic_api_key": os.getenv("ANTHROPIC_API_KEY", ""),
    }


async def _generate_ollama(
    system_prompt: str, user_prompt: str, temperature: float = 0.8, max_tokens: int = 1024,
) -> str:
    """Generate text using Ollama with exponential backoff on transient failures.

    Connection errors (Ollama down / restarting) and 5xx responses are retried
    with backoff 2s → 6s → 18s. Non-retryable errors (4xx, JSON parse) bubble
    immediately. Keeps the per-attempt timeout at 300s so a slow model that
    actually responds isn't cut off.
    """
    cfg = _get_config()
    payload = {
        "model": cfg["ollama_llm_model"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "stream": False,
        "think": False,  # Disable thinking mode (qwen3.5 etc.)
        "options": {"temperature": temperature, "num_predict": max_tokens},
    }

    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=300.0) as client:
                resp = await client.post(
                    f"{cfg['ollama_base_url']}/api/chat", json=payload,
                )
                if 500 <= resp.status_code < 600:
                    # Server-side transient — retryable
                    raise httpx.HTTPStatusError(
                        f"ollama 5xx: {resp.status_code}",
                        request=resp.request, response=resp,
                    )
                resp.raise_for_status()
                msg = resp.json()["message"]
                content = msg.get("content", "")
                if not content and msg.get("thinking"):
                    content = msg["thinking"]
                return content
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.HTTPStatusError) as e:
            last_exc = e
            if attempt == 2:
                break
            wait = 2 * (3 ** attempt)  # 2s, 6s, (18s if a 4th attempt existed)
            logger.warn(
                "ollama_transient_error_retrying",
                attempt=attempt + 1, wait_seconds=wait, error=str(e)[:120],
            )
            await asyncio.sleep(wait)
    assert last_exc is not None
    raise last_exc


async def _generate_claude(
    system_prompt: str, user_prompt: str, temperature: float = 0.8, max_tokens: int = 1024,
) -> str:
    """Generate text using Claude API."""
    import anthropic
    cfg = _get_config()
    client = anthropic.AsyncAnthropic(api_key=cfg["anthropic_api_key"])
    response = await client.messages.create(
        model=cfg["claude_model"],
        max_tokens=max_tokens,
        temperature=temperature,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )
    return response.content[0].text


async def _generate(
    system_prompt: str, user_prompt: str, temperature: float = 0.8, max_tokens: int = 1024,
) -> str:
    """Route to the configured LLM provider."""
    cfg = _get_config()
    if cfg["llm_provider"] == "ollama":
        return await _generate_ollama(system_prompt, user_prompt, temperature, max_tokens)
    elif cfg["llm_provider"] == "api" and cfg["anthropic_api_key"]:
        return await _generate_claude(system_prompt, user_prompt, temperature, max_tokens)
    else:
        raise RuntimeError(f"No LLM provider available (LLM_PROVIDER={cfg['llm_provider']})")


def _parse_post_json(text: str) -> dict[str, object]:
    """Try to extract JSON from LLM response.

    Handles: raw JSON, markdown code blocks, qwen-style <think> tags,
    and other wrapper formats.
    """
    import re

    # Strip thinking tags (qwen3.5 and other reasoning models)
    cleaned = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()

    # Try parsing cleaned text directly
    for candidate in [cleaned, text]:
        # Try direct JSON parse
        try:
            return json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            pass

        # Try extracting from markdown code block
        try:
            if "```" in candidate:
                match = re.search(r'```(?:json)?\s*\n?(.*?)```', candidate, re.DOTALL)
                if match:
                    return json.loads(match.group(1).strip())
        except (json.JSONDecodeError, ValueError):
            pass

        # Try finding first { ... } block
        try:
            brace_match = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', candidate, re.DOTALL)
            if brace_match:
                return json.loads(brace_match.group(0))
        except (json.JSONDecodeError, ValueError):
            pass

    # Last resort: return the text as content
    # Use cleaned (thinking-stripped) version for the content
    content = cleaned if cleaned else text
    # Strip any remaining markdown/code artifacts
    content = re.sub(r'```.*?```', '', content, flags=re.DOTALL).strip()
    # Log only shape info — the response can contain partial user-paper content
    # or PII echoed back from chunks. Keep debugging possible without leaking
    # content into host logs.
    logger.warn(
        "post_json_parse_failed",
        response_length=len(content),
        response_type=type(content).__name__,
    )
    return {"post_type": "post", "content": content}


async def generate_persona_post(
    system_prompt: str, user_prompt: str, temperature: float = 0.8,
) -> dict[str, object]:
    """Generate a structured persona post using the configured LLM.

    Returns dict matching the post schema.
    """
    logger.info("persona_post_generating", provider=_get_config()["llm_provider"])
    text = await _generate(system_prompt, user_prompt, temperature=temperature)
    return _parse_post_json(text)


async def classify_contradiction(chunk_a: str, chunk_b: str) -> str:
    """Classify the relationship between two chunks.

    Returns one of: 'supports', 'contradicts', 'extends'.
    """
    from lib.sanitize import fence_untrusted

    # Both passages are extracted PDF content — fence them so a hostile
    # document can't pivot the classifier into following embedded instructions.
    fenced_a = fence_untrusted(chunk_a)
    fenced_b = fence_untrusted(chunk_b)

    prompt = f"""Compare these two passages from academic papers and classify their relationship.

PASSAGE A:
{fenced_a}

PASSAGE B:
{fenced_b}

Respond with exactly one word: supports, contradicts, or extends

- supports: Passage B provides evidence for or agrees with Passage A's claims
- contradicts: Passage B disagrees with, challenges, or presents conflicting evidence to Passage A
- extends: Passage B builds on Passage A by adding new dimensions, caveats, or applications"""

    text = await _generate("You are a precise academic text classifier. Respond with exactly one word.", prompt)
    result = text.strip().lower().rstrip(".")

    # Extract the classification word from potentially longer responses
    for word in ("supports", "contradicts", "extends"):
        if word in result:
            return word

    logger.warn("contradiction_classify_unexpected", result=result)
    return "extends"


# Persistent event loop for all sync wrappers in this module. Same pattern
# as lib/db.py and lib/embedder.py — avoids `asyncio.run()` creating a
# fresh loop per call, which left httpx connections getting GC'd on a
# dead loop and surfacing `RuntimeError('Event loop is closed')` in the
# worker's "Task exception was never retrieved" warnings (BUG-LIVE-06).
import threading

_llm_loop: asyncio.AbstractEventLoop | None = None
_llm_loop_lock = threading.Lock()


def _run_on_llm_loop(coro):
    global _llm_loop
    with _llm_loop_lock:
        if _llm_loop is None or _llm_loop.is_closed():
            _llm_loop = asyncio.new_event_loop()
        return _llm_loop.run_until_complete(coro)


def generate_persona_post_sync(
    system_prompt: str, user_prompt: str, temperature: float = 0.8,
) -> dict[str, object]:
    """Synchronous wrapper for use in Celery tasks."""
    return _run_on_llm_loop(generate_persona_post(system_prompt, user_prompt, temperature=temperature))


def generate_text_sync(
    system_prompt: str, user_prompt: str, temperature: float = 0.7, max_tokens: int = 1024,
) -> str:
    """Synchronous wrapper that returns raw text (no JSON parsing). For Celery tasks."""
    return _run_on_llm_loop(_generate(system_prompt, user_prompt, temperature=temperature, max_tokens=max_tokens))


def classify_contradiction_sync(chunk_a: str, chunk_b: str) -> str:
    """Synchronous wrapper for use in Celery tasks."""
    return _run_on_llm_loop(classify_contradiction(chunk_a, chunk_b))
