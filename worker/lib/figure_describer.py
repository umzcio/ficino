"""Figure description and claim mapping using vision models.

Supports Claude Vision API and Ollama vision models.
If no vision model is available, returns empty descriptions.
"""

import asyncio
import base64
import os

import httpx
import structlog

logger = structlog.get_logger(__name__)

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "ollama")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434")
OLLAMA_VISION_MODEL = os.getenv("OLLAMA_VISION_MODEL", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

FIGURE_PROMPT = """Analyze this figure from an academic paper. Provide:

1. **Description**: A clear, concise description of what the figure shows.
2. **Claim Summary**: What claim or finding does this figure support? One sentence.

Format your response as:
DESCRIPTION: <description>
CLAIM: <claim summary>"""


def is_available() -> bool:
    """Check if figure description is available."""
    if LLM_PROVIDER == "api" and ANTHROPIC_API_KEY:
        return True
    if LLM_PROVIDER == "ollama" and OLLAMA_VISION_MODEL:
        return True
    return False


async def _describe_claude(image_bytes: bytes) -> str:
    import anthropic
    client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    image_b64 = base64.b64encode(image_bytes).decode("utf-8")

    response = await client.messages.create(
        model="claude-sonnet-4-20250514",
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
    image_b64 = base64.b64encode(image_bytes).decode("utf-8")

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{OLLAMA_BASE_URL}/api/chat",
            json={
                "model": OLLAMA_VISION_MODEL,
                "messages": [
                    {"role": "user", "content": FIGURE_PROMPT, "images": [image_b64]},
                ],
                "stream": False,
            },
        )
        resp.raise_for_status()
        return resp.json()["message"]["content"]


def _parse_description(text: str) -> dict[str, str]:
    description = ""
    claim = ""
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("DESCRIPTION:"):
            description = line[len("DESCRIPTION:"):].strip()
        elif line.startswith("CLAIM:"):
            claim = line[len("CLAIM:"):].strip()
    if not description:
        description = text[:500]
    if not claim:
        claim = description[:200]
    return {"description": description, "claim_summary": claim}


async def describe_figure(image_bytes: bytes) -> dict[str, str]:
    """Describe a figure image using the configured vision provider.

    Returns dict with keys: description (str), claim_summary (str).
    If no vision provider is available, returns empty strings.
    """
    if not is_available():
        logger.warn("no_vision_provider_for_figures")
        return {"description": "", "claim_summary": ""}

    logger.info("figure_describe_start", provider=LLM_PROVIDER)

    if LLM_PROVIDER == "api" and ANTHROPIC_API_KEY:
        text = await _describe_claude(image_bytes)
    else:
        text = await _describe_ollama(image_bytes)

    return _parse_description(text)


def describe_figure_sync(image_bytes: bytes) -> dict[str, str]:
    """Synchronous wrapper for use in Celery tasks."""
    return asyncio.run(describe_figure(image_bytes))
