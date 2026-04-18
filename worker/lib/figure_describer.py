"""Figure description and claim mapping using vision models.

Provider is selected via VISION_PROVIDER setting (ollama or api).
If no vision model is available, returns empty descriptions.
"""

import asyncio
import base64
import os

import httpx
import structlog

logger = structlog.get_logger(__name__)

FIGURE_PROMPT = """Analyze this figure from an academic paper. Provide:

1. **Description**: A clear, concise description of what the figure shows.
2. **Claim Summary**: What claim or finding does this figure support? One sentence.

Format your response as:
DESCRIPTION: <description>
CLAIM: <claim summary>"""


def _get_config() -> dict[str, str]:
    """Read vision config from env at call time (supports runtime changes via settings)."""
    return {
        "vision_provider": os.getenv("VISION_PROVIDER", os.getenv("LLM_PROVIDER", "ollama")),
        "ollama_base_url": os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434"),
        "ollama_vision_model": os.getenv("OLLAMA_VISION_MODEL", ""),
        "anthropic_api_key": os.getenv("ANTHROPIC_API_KEY", ""),
        "claude_model": os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6"),
    }


def is_available() -> bool:
    """Check if figure description is available."""
    cfg = _get_config()
    if cfg["vision_provider"] == "api" and cfg["anthropic_api_key"]:
        return True
    if cfg["vision_provider"] == "ollama" and cfg["ollama_vision_model"]:
        return True
    return False


async def _describe_claude(image_bytes: bytes) -> str:
    import anthropic
    cfg = _get_config()
    client = anthropic.AsyncAnthropic(api_key=cfg["anthropic_api_key"])
    image_b64 = base64.b64encode(image_bytes).decode("utf-8")

    response = await client.messages.create(
        model=cfg["claude_model"],
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": image_b64}},
                {"type": "text", "text": FIGURE_PROMPT},
            ],
        }],
    )
    return response.content[0].text


async def _describe_ollama(image_bytes: bytes) -> str:
    cfg = _get_config()
    image_b64 = base64.b64encode(image_bytes).decode("utf-8")

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{cfg['ollama_base_url']}/api/chat",
            json={
                "model": cfg["ollama_vision_model"],
                "messages": [
                    {"role": "user", "content": FIGURE_PROMPT, "images": [image_b64]},
                ],
                "stream": False,
            },
        )
        resp.raise_for_status()
        return resp.json()["message"]["content"]


def _parse_description(text: str) -> dict[str, str]:
    """Parse `DESCRIPTION:` / `CLAIM:` blocks from a vision model's response.

    Returns empty strings when the expected labels aren't present — the
    caller logs + skips the figure. We deliberately do NOT fall back to
    `text[:500]` the way we used to, because that raw vision output later
    flows into persona prompts, and a malformed response (or one that's
    actually an instruction payload) would ride along unchecked.
    """
    description = ""
    claim = ""
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("DESCRIPTION:"):
            description = line[len("DESCRIPTION:"):].strip()
        elif line.startswith("CLAIM:"):
            claim = line[len("CLAIM:"):].strip()

    # Light sanity bounds. Vision models sometimes emit enormous single lines;
    # truncate to protect downstream prompt size.
    description = description[:1000]
    claim = claim[:400]

    if not description or not claim:
        logger.warn(
            "figure_description_unparseable",
            has_description=bool(description),
            has_claim=bool(claim),
            preview=text[:120],
        )
        return {"description": "", "claim_summary": ""}

    return {"description": description, "claim_summary": claim}


async def describe_figure(image_bytes: bytes) -> dict[str, str]:
    """Describe a figure image using the configured vision provider.

    Returns dict with keys: description (str), claim_summary (str).
    If no vision provider is available, returns empty strings.
    """
    if not is_available():
        logger.warn("no_vision_provider_for_figures")
        return {"description": "", "claim_summary": ""}

    cfg = _get_config()
    logger.info("figure_describe_start", provider=cfg["vision_provider"])

    if cfg["vision_provider"] == "api" and cfg["anthropic_api_key"]:
        text = await _describe_claude(image_bytes)
    else:
        text = await _describe_ollama(image_bytes)

    return _parse_description(text)


# Persistent event loop for the sync wrapper — prevents httpx GC on a
# dead loop (see BUG-LIVE-06 in phase2 playwright report).
# Round-4: loop runs on a dedicated daemon thread via run_forever so
# concurrent Celery threads don't serialize behind a single run_until_complete.
import threading as _threading

_figure_loop: asyncio.AbstractEventLoop | None = None
_figure_loop_lock = _threading.Lock()


def _ensure_figure_loop() -> asyncio.AbstractEventLoop:
    global _figure_loop
    if _figure_loop is not None and not _figure_loop.is_closed():
        return _figure_loop
    with _figure_loop_lock:
        if _figure_loop is None or _figure_loop.is_closed():
            loop = asyncio.new_event_loop()

            def _runner() -> None:
                asyncio.set_event_loop(loop)
                loop.run_forever()

            t = _threading.Thread(target=_runner, name="figure-loop", daemon=True)
            t.start()
            _figure_loop = loop
        return _figure_loop


def _run_on_figure_loop(coro):
    loop = _ensure_figure_loop()
    return asyncio.run_coroutine_threadsafe(coro, loop).result()


def describe_figure_sync(image_bytes: bytes) -> dict[str, str]:
    """Synchronous wrapper for use in Celery tasks."""
    return _run_on_figure_loop(describe_figure(image_bytes))
