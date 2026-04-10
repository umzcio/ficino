"""Vision-based PDF extraction — page-by-page PDF to markdown.

Fallback path for PDFs where primary extraction produces garbled output.
Supports Claude Vision API and Ollama vision models (e.g., llava).
"""

import asyncio
import base64
import os

import httpx
import structlog

from lib.pdf_extractor import rasterize_page, get_page_count

logger = structlog.get_logger(__name__)

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "ollama")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434")
OLLAMA_VISION_MODEL = os.getenv("OLLAMA_VISION_MODEL", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

VISION_SYSTEM_PROMPT = """You are an academic paper text extractor. Convert the page image into clean, structured markdown.

Rules:
- Preserve section headings as markdown headings (# for main, ## for sub)
- Preserve paragraph breaks
- Convert tables to markdown tables
- Describe figures/diagrams in [Figure N: description] brackets
- Preserve footnotes at the bottom with [^N] markers
- Do NOT add commentary — output only the text content of the page
- If the page is blank or contains only a figure, say [blank page] or [Figure only: description]"""


def is_available() -> bool:
    """Check if vision extraction is available."""
    if LLM_PROVIDER == "api" and ANTHROPIC_API_KEY:
        return True
    if LLM_PROVIDER == "ollama" and OLLAMA_VISION_MODEL:
        return True
    return False


async def _extract_page_claude(page_image: bytes, page_num: int) -> str:
    """Extract text from a page image using Claude Vision."""
    import anthropic
    client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    image_b64 = base64.b64encode(page_image).decode("utf-8")

    response = await client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=4096,
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
    image_b64 = base64.b64encode(page_image).decode("utf-8")

    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(
            f"{OLLAMA_BASE_URL}/api/chat",
            json={
                "model": OLLAMA_VISION_MODEL,
                "messages": [
                    {"role": "system", "content": VISION_SYSTEM_PROMPT},
                    {"role": "user", "content": f"Extract all text from page {page_num} as structured markdown.",
                     "images": [image_b64]},
                ],
                "stream": False,
            },
        )
        resp.raise_for_status()
        return resp.json()["message"]["content"]


async def extract_page(page_image: bytes, page_num: int) -> str:
    """Extract text from a single page image using the configured provider."""
    if LLM_PROVIDER == "api" and ANTHROPIC_API_KEY:
        return await _extract_page_claude(page_image, page_num)
    elif LLM_PROVIDER == "ollama" and OLLAMA_VISION_MODEL:
        return await _extract_page_ollama(page_image, page_num)
    else:
        raise RuntimeError("No vision provider available")


async def extract_with_vision(file_path: str) -> str:
    """Extract text from entire PDF using vision, page by page."""
    if not is_available():
        raise RuntimeError("No vision provider available (set OLLAMA_VISION_MODEL or ANTHROPIC_API_KEY)")

    page_count = get_page_count(file_path)
    logger.info("vision_extract_start", file_path=file_path, pages=page_count, provider=LLM_PROVIDER)

    pages_markdown: list[str] = []
    for page_num in range(page_count):
        logger.info("vision_extract_page", page=page_num + 1, total=page_count)
        page_image = rasterize_page(file_path, page_num, dpi=200)
        page_text = await extract_page(page_image, page_num + 1)
        pages_markdown.append(page_text)

    full_markdown = "\n\n---\n\n".join(pages_markdown)
    logger.info("vision_extract_complete", length=len(full_markdown))
    return full_markdown


def extract_with_vision_sync(file_path: str) -> str:
    """Synchronous wrapper for use in Celery tasks."""
    return asyncio.run(extract_with_vision(file_path))
