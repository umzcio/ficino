"""Vision-based PDF extraction — page-by-page PDF to markdown.

Fallback path for PDFs where primary extraction produces garbled output.
Provider is selected via VISION_PROVIDER setting (ollama or api).
"""

import asyncio
import base64
import os
import threading as _threading

import httpx
import structlog

from lib.pdf_extractor import rasterize_pages, get_page_count
from lib.settings import get_active

logger = structlog.get_logger(__name__)

VISION_SYSTEM_PROMPT = """You are an academic paper text extractor. Convert the page image into clean, structured markdown.

Rules:
- Preserve section headings as markdown headings (# for main, ## for sub)
- Preserve paragraph breaks
- Convert tables to markdown tables
- Describe figures/diagrams in [Figure N: description] brackets
- Preserve footnotes at the bottom with [^N] markers
- Do NOT add commentary — output only the text content of the page
- If the page is blank or contains only a figure, say [blank page] or [Figure only: description]"""


def _get_config() -> dict[str, str]:
    """Read vision config from active provider settings, falling back to env."""
    return {
        "vision_provider": get_active(
            "vision_provider", "VISION_PROVIDER",
            get_active("llm_provider", "LLM_PROVIDER", "ollama"),
        ),
        # ollama_base_url is env-only (SSRF defense).
        "ollama_base_url": os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434"),
        "ollama_vision_model": get_active("ollama_vision_model", "OLLAMA_VISION_MODEL", ""),
        "anthropic_api_key": get_active("anthropic_api_key", "ANTHROPIC_API_KEY", ""),
        "claude_model": get_active("claude_model", "CLAUDE_MODEL", "claude-sonnet-4-6"),
    }


def is_available() -> bool:
    """Check if vision extraction is available."""
    cfg = _get_config()
    if cfg["vision_provider"] == "api" and cfg["anthropic_api_key"]:
        return True
    if cfg["vision_provider"] == "ollama" and cfg["ollama_vision_model"]:
        return True
    return False


async def _extract_page_claude(page_image: bytes, page_num: int) -> str:
    """Extract text from a page image using Claude Vision."""
    import anthropic
    cfg = _get_config()
    client = anthropic.AsyncAnthropic(api_key=cfg["anthropic_api_key"])
    image_b64 = base64.b64encode(page_image).decode("utf-8")

    # 2048 output tokens is more than enough for a full page of extracted
    # markdown; the prior 4096 doubled cost exposure without payoff. Combined
    # with MAX_VISION_PAGES in extract_with_vision, this bounds the worst-
    # case paid-API spend a crafted PDF can force through the shared key.
    response = await client.messages.create(
        model=cfg["claude_model"],
        max_tokens=2048,
        system=VISION_SYSTEM_PROMPT,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": image_b64}},
                {"type": "text", "text": f"Extract all text from page {page_num} as structured markdown."},
            ],
        }],
    )
    return response.content[0].text


async def _extract_page_ollama(page_image: bytes, page_num: int) -> str:
    """Extract text from a page image using Ollama vision model."""
    cfg = _get_config()
    image_b64 = base64.b64encode(page_image).decode("utf-8")

    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(
            f"{cfg['ollama_base_url']}/api/chat",
            json={
                "model": cfg["ollama_vision_model"],
                "messages": [
                    {"role": "system", "content": VISION_SYSTEM_PROMPT},
                    {"role": "user", "content": f"Extract all text from page {page_num} as structured markdown.",
                     "images": [image_b64]},
                ],
                "stream": False,
            },
        )
        resp.raise_for_status()
        content = resp.json()["message"]["content"]
        # A 200 with empty content means the model is misconfigured (wrong
        # name, OOM, unreachable upstream). Raising here lets the outer
        # `extract_with_vision` abort and mark the paper 'error' with a
        # reason, instead of silently producing a 0-chunk paper.
        if not content or not content.strip():
            raise RuntimeError(
                f"ollama vision model {cfg['ollama_vision_model']!r} returned "
                f"empty content for page {page_num}"
            )
        return content


async def extract_page(page_image: bytes, page_num: int) -> str:
    """Extract text from a single page image using the configured provider."""
    cfg = _get_config()
    if cfg["vision_provider"] == "api" and cfg["anthropic_api_key"]:
        return await _extract_page_claude(page_image, page_num)
    elif cfg["vision_provider"] == "ollama" and cfg["ollama_vision_model"]:
        return await _extract_page_ollama(page_image, page_num)
    else:
        raise RuntimeError("No vision provider available")


async def extract_with_vision(file_path: str) -> str:
    """Extract text from entire PDF using vision, page by page.

    Bounded by MAX_VISION_PAGES (default 100) so a crafted 600-page PDF can't
    burn ~$50 of Claude Vision spend per upload through the shared API key.
    Papers longer than the cap are truncated with a warning; chunks for the
    untruncated pages still index correctly.
    """
    if not is_available():
        raise RuntimeError("No vision provider available (set OLLAMA_VISION_MODEL or ANTHROPIC_API_KEY)")

    cfg = _get_config()
    page_count = get_page_count(file_path)
    max_pages = int(os.getenv("MAX_VISION_PAGES", "100"))
    pages_to_process = min(page_count, max_pages)
    if page_count > max_pages:
        logger.warn(
            "vision_extract_truncated",
            file_path=file_path, total_pages=page_count, max_pages=max_pages,
        )
    logger.info(
        "vision_extract_start",
        file_path=file_path, pages=pages_to_process, total=page_count,
        provider=cfg["vision_provider"],
    )

    pages_markdown: list[str] = []
    # Open the PDF once and stream pixmaps — avoids the O(pages) cost of
    # re-opening the document per rasterize_page call inside the loop.
    rasterizer = rasterize_pages(file_path, range(pages_to_process), dpi=200)
    for page_num, page_image in enumerate(rasterizer):
        logger.info("vision_extract_page", page=page_num + 1, total=pages_to_process)
        page_text = await extract_page(page_image, page_num + 1)
        pages_markdown.append(page_text)

    full_markdown = "\n\n---\n\n".join(pages_markdown)
    logger.info("vision_extract_complete", length=len(full_markdown))
    return full_markdown


# Persistent event loop to avoid the asyncio.run() + httpx-GC race —
# same pattern as the other worker/lib sync wrappers. BUG-LIVE-06.
# Round-4: loop runs on a dedicated daemon thread; concurrent callers
# submit via run_coroutine_threadsafe instead of queuing on a lock.

_vision_loop: asyncio.AbstractEventLoop | None = None
_vision_loop_lock = _threading.Lock()


def _ensure_vision_loop() -> asyncio.AbstractEventLoop:
    global _vision_loop
    if _vision_loop is not None and not _vision_loop.is_closed():
        return _vision_loop
    with _vision_loop_lock:
        if _vision_loop is None or _vision_loop.is_closed():
            loop = asyncio.new_event_loop()

            def _runner() -> None:
                asyncio.set_event_loop(loop)
                loop.run_forever()

            t = _threading.Thread(target=_runner, name="vision-loop", daemon=True)
            t.start()
            _vision_loop = loop
        return _vision_loop


def _run_on_vision_loop(coro):
    loop = _ensure_vision_loop()
    return asyncio.run_coroutine_threadsafe(coro, loop).result()


def extract_with_vision_sync(file_path: str) -> str:
    """Synchronous wrapper for use in Celery tasks."""
    return _run_on_vision_loop(extract_with_vision(file_path))
