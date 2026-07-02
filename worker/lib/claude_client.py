"""LLM client for persona post generation and contradiction classification.

Supports both Claude API and Ollama as providers.
Provider is selected via LLM_PROVIDER env var:
  - "ollama": uses local Ollama (default, free)
  - "api": uses Anthropic Claude API
"""

import asyncio
import json

import httpx
import structlog

from lib.event_loop import LoopRunner
from lib.settings import get_active, ollama_base_url

logger = structlog.get_logger(__name__)

def _get_config() -> dict[str, str]:
    """Read LLM config from the active provider settings, falling back to env.

    Prefers the per-task dict published by apply_provider_settings so a
    concurrent task in another Celery process can't swap env keys mid-call
    and bill user A's Claude usage to user B's API key.
    """
    return {
        "llm_provider": get_active("llm_provider", "LLM_PROVIDER", "ollama"),
        # ollama_base_url is NOT user-overridable (SSRF defense) — env only.
        "ollama_base_url": ollama_base_url(),
        "ollama_llm_model": get_active("ollama_llm_model", "OLLAMA_LLM_MODEL", "qwen3.5:latest"),
        "claude_model": get_active("claude_model", "CLAUDE_MODEL", "claude-sonnet-4-6"),
        "anthropic_api_key": get_active("anthropic_api_key", "ANTHROPIC_API_KEY", ""),
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
                # Ollama can return HTTP 200 with empty content (model hit
                # num_predict with no text, or whitespace-only). Raise here
                # so callers see a concrete failure instead of a silent ""
                # propagating up through generate_persona_post — matches
                # api/services/llm.py's guard (R10 DUP-7b).
                if not content or not content.strip():
                    raise RuntimeError("LLM returned empty response")
                return content
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.HTTPStatusError) as e:
            if isinstance(e, httpx.HTTPStatusError) and e.response.status_code < 500:
                raise  # 4xx = caller error (bad model name etc.) — retrying can't help
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


def _find_balanced_json_object(text: str) -> str | None:
    """Return the first top-level `{...}` substring with balanced braces.

    Walks char-by-char incrementing on `{` and decrementing on `}`, returning
    when the counter returns to zero. Crucially, skips over string literals
    so braces inside `"..."` don't count — this handles arbitrarily nested
    JSON (`{"a": {"b": {"c": 1}}}`) that the prior regex
    `\\{[^{}]*(?:\\{[^{}]*\\}[^{}]*)*\\}` could only match at 1 level deep.

    Treats `\\"` inside strings as an escaped quote, not a terminator. No
    attempt at full JSON grammar — just find a brace-balanced candidate to
    hand to json.loads. Returns None if no complete object is found.
    """
    start = text.find("{")
    if start == -1:
        return None

    depth = 0
    in_string = False
    escape_next = False
    for i in range(start, len(text)):
        ch = text[i]
        if escape_next:
            escape_next = False
            continue
        if in_string:
            if ch == "\\":
                escape_next = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


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

        # Try finding first balanced { ... } block. Hand-rolled walker instead
        # of regex so deeply nested objects (thread_posts, sources arrays
        # inside parent objects) parse cleanly.
        try:
            balanced = _find_balanced_json_object(candidate)
            if balanced:
                return json.loads(balanced)
        except (json.JSONDecodeError, ValueError):
            pass

    # Last resort: the model returned plain text instead of a JSON object.
    # Wrap it as a post IF the text is substantive — otherwise raise so the
    # caller drops the slot. We no longer manufacture `[generation produced
    # no text]` / `[generation produced malformed output]` placeholders; a
    # research-grade feed should not ship user-facing apology text as a
    # "post". Callers are expected to catch ValueError and continue past
    # the failed slot.
    content = cleaned if cleaned else text
    content = re.sub(r'```.*?```', '', content, flags=re.DOTALL).strip()

    # MED-15: strip role markers so a leaked "Assistant:" / "System:" in the
    # raw LLM output doesn't end up persisted verbatim into feeds.posts.
    # No fence wrapping — that's a prompt-time concern, not a storage one.
    from lib.sanitize import strip_role_markers
    content = strip_role_markers(content)

    # Empty / whitespace-only means the LLM produced nothing usable. Drop.
    if not content.strip():
        logger.warn("post_json_empty_response_dropped")
        raise ValueError("persona_post_empty_content")

    # Absurdly long blobs are almost certainly chain-of-thought spillage,
    # not a post. Drop rather than persist a novel.
    if len(content) > 4000:
        logger.warn("post_json_fallback_too_long_dropped", response_length=len(content))
        raise ValueError("persona_post_content_too_long")

    # Substantive plaintext — wrap as a plain post. Log the parse drift so
    # we can see how often models ignore the JSON contract, but do not
    # surface shape info that would leak chunk/PII content.
    logger.warn("post_json_parse_failed_wrapped_as_plaintext",
                response_length=len(content))
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


# Shared background event loop for all sync wrappers in this module (R10
# DUP-5: LoopRunner). Same pattern as lib/db.py and lib/embedder.py —
# avoids `asyncio.run()` creating a fresh loop per call, which left httpx
# connections getting GC'd on a dead loop and surfacing
# `RuntimeError('Event loop is closed')` in the worker's "Task exception
# was never retrieved" warnings (BUG-LIVE-06).
#
# Round-4: the loop runs forever on a dedicated daemon thread and
# coroutines are submitted via `run_coroutine_threadsafe`. The previous
# `with _lock: loop.run_until_complete(coro)` pattern serialized every
# LLM call in the process (one at a time across all Celery pool workers
# in the same process), squandering async concurrency.

_runner = LoopRunner("llm-loop")


def _run_on_llm_loop(coro):
    return _runner.run(coro)


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


async def _classify_contradictions_batch(
    pairs: list[tuple[str, str]], concurrency: int = 5,
) -> list[str]:
    """Classify a list of chunk pairs with bounded concurrent API calls.

    Errors per-pair don't abort the batch — they come back as "error" so
    the caller can log and continue. That matches the prior per-pair
    try/except behaviour where one hiccup didn't kill the whole check.
    """
    sem = asyncio.Semaphore(concurrency)

    async def one(chunk_a: str, chunk_b: str) -> str:
        async with sem:
            try:
                return await classify_contradiction(chunk_a, chunk_b)
            except Exception as e:
                logger.warning("contradiction_classify_failed", error=str(e))
                return "error"

    return await asyncio.gather(*(one(a, b) for a, b in pairs))


def classify_contradictions_batch_sync(
    pairs: list[tuple[str, str]], concurrency: int = 5,
) -> list[str]:
    """Batched, bounded-concurrent classify for Celery tasks.

    Collapses what was ~24 serial Claude calls (~17s on p95) into one
    gather with at most `concurrency` in flight at a time (~3–4s).
    """
    return _run_on_llm_loop(_classify_contradictions_batch(pairs, concurrency))
