"""Vision-based PDF extraction — page-by-page PDF to markdown.

Fallback path for PDFs where primary extraction produces garbled output.
Provider is selected via VISION_PROVIDER setting (ollama or api).
"""

import asyncio
import base64
import os

import httpx
import structlog

from lib.event_loop import LoopRunner
from lib.pdf_extractor import rasterize_pages, get_page_count
from lib.settings import get_active, ollama_base_url
from ficino_shared.settings_schema import default_for

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
        "ollama_base_url": ollama_base_url(),
        "ollama_vision_model": get_active("ollama_vision_model", "OLLAMA_VISION_MODEL", default_for("ollama_vision_model")),
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
    """Extract text from a page image using Claude Vision.

    Retries connection errors, rate limits, and 5xx responses 3x with
    exponential backoff (2s / 6s / 18s) — same shape as `_generate_ollama`
    in claude_client.py. Vision extraction is the priciest worker code
    path; without retry, a single transient blip on page N of an N-page
    paper aborts the whole extraction, and the Celery retry then re-runs
    (and re-bills) every prior page (R10 WORK-9).
    """
    import anthropic
    cfg = _get_config()
    # max_retries=0: the outer 3-attempt loop below owns retries. The SDK
    # default (2 internal retries) would stack to up to 9 requests per page
    # with compounding delays — mirrors api/services/llm.py's H30 pin.
    client = anthropic.AsyncAnthropic(api_key=cfg["anthropic_api_key"], max_retries=0)
    image_b64 = base64.b64encode(page_image).decode("utf-8")

    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            # 2048 output tokens is more than enough for a full page of
            # extracted markdown; the prior 4096 doubled cost exposure
            # without payoff. Combined with MAX_VISION_PAGES in
            # extract_with_vision, this bounds the worst-case paid-API
            # spend a crafted PDF can force through the shared key.
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
        except (anthropic.APIConnectionError, anthropic.RateLimitError, anthropic.InternalServerError) as e:
            last_exc = e
            if attempt == 2:
                break
            wait = 2 * (3 ** attempt)  # 2s, 6s, (18s if a 4th attempt existed)
            logger.warning(
                "claude_vision_transient_error_retrying",
                page=page_num, attempt=attempt + 1, wait_seconds=wait, error=str(e)[:120],
            )
            await asyncio.sleep(wait)
    assert last_exc is not None
    raise last_exc


async def _extract_page_ollama(page_image: bytes, page_num: int) -> str:
    """Extract text from a page image using Ollama vision model.

    Retries connection errors and 5xx responses 3x with exponential
    backoff (2s / 6s / 18s) — same shape as `_generate_ollama` in
    claude_client.py. Without retry, a single transient blip on page N of
    an N-page paper aborts the whole extraction (R10 WORK-9).
    """
    cfg = _get_config()
    image_b64 = base64.b64encode(page_image).decode("utf-8")
    payload = {
        "model": cfg["ollama_vision_model"],
        "messages": [
            {"role": "system", "content": VISION_SYSTEM_PROMPT},
            {"role": "user", "content": f"Extract all text from page {page_num} as structured markdown.",
             "images": [image_b64]},
        ],
        "stream": False,
    }

    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=300.0) as client:
                resp = await client.post(
                    f"{cfg['ollama_base_url']}/api/chat", json=payload,
                )
                if 500 <= resp.status_code < 600:
                    raise httpx.HTTPStatusError(
                        f"ollama 5xx: {resp.status_code}",
                        request=resp.request, response=resp,
                    )
                resp.raise_for_status()
                content = resp.json()["message"]["content"]
                # A 200 with empty content means the model is misconfigured
                # (wrong name, OOM, unreachable upstream). Raising here lets
                # the outer `extract_with_vision` abort and mark the paper
                # 'error' with a reason, instead of silently producing a
                # 0-chunk paper. Not retried — it's a config problem, not a
                # transient one.
                if not content or not content.strip():
                    raise RuntimeError(
                        f"ollama vision model {cfg['ollama_vision_model']!r} returned "
                        f"empty content for page {page_num}"
                    )
                return content
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.HTTPStatusError) as e:
            last_exc = e
            if attempt == 2:
                break
            wait = 2 * (3 ** attempt)  # 2s, 6s, (18s if a 4th attempt existed)
            logger.warning(
                "ollama_vision_transient_error_retrying",
                page=page_num, attempt=attempt + 1, wait_seconds=wait, error=str(e)[:120],
            )
            await asyncio.sleep(wait)
    assert last_exc is not None
    raise last_exc


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
        logger.warning(
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


# Shared background event loop to avoid the asyncio.run() + httpx-GC race —
# same pattern as the other worker/lib sync wrappers (R10 DUP-5:
# LoopRunner). BUG-LIVE-06.
# Round-4: loop runs on a dedicated daemon thread; concurrent callers
# submit via run_coroutine_threadsafe instead of queuing on a lock.

_runner = LoopRunner("vision-loop")


def _run_on_vision_loop(coro):
    return _runner.run(coro)


def extract_with_vision_sync(file_path: str) -> str:
    """Synchronous wrapper for use in Celery tasks."""
    return _run_on_vision_loop(extract_with_vision(file_path))
