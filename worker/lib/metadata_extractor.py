"""Extract paper metadata (title, authors, year, DOI) from extracted text.

Uses the first ~2000 chars of extracted text (typically title page, abstract)
and asks the LLM to pull structured metadata. Falls back gracefully if
extraction fails.
"""

import asyncio
import json
import re

import structlog

from lib import claude_client

logger = structlog.get_logger(__name__)

METADATA_PROMPT = """Extract the following metadata from this academic paper text. This is the beginning of the paper.

TEXT:
{text}

Respond with ONLY a JSON object (no markdown, no explanation):
{{
  "title": "Full paper title",
  "authors": ["First Author", "Second Author"],
  "year": 2024,
  "doi": "10.xxxx/xxxxx or null if not found"
}}

Rules:
- Title should be the full paper title, not abbreviated
- Authors should be individual names, not institution names
- Year should be the publication year as an integer
- DOI should be the full DOI string if found, otherwise null
- If you cannot determine a field, use null for strings/numbers or [] for authors
- Do NOT guess or fabricate — only extract what is clearly present in the text"""


async def extract_metadata(text: str) -> dict[str, object]:
    """Extract metadata from the beginning of a paper's text.

    Args:
        text: The first ~2000 chars of extracted paper text

    Returns:
        Dict with keys: title, authors, year, doi (any can be None)
    """
    # Take the first ~2000 chars — enough for title page + abstract
    sample = text[:2000]

    prompt = METADATA_PROMPT.format(text=sample)

    try:
        raw = await claude_client._generate(
            "You are a precise metadata extractor. Respond with only valid JSON.",
            prompt,
        )

        # Clean thinking tags and parse
        cleaned = re.sub(r'<think>.*?</think>', '', raw, flags=re.DOTALL).strip()

        # Try to find JSON object
        match = re.search(r'\{.*\}', cleaned, re.DOTALL)
        if match:
            data = json.loads(match.group(0))
            result = {
                "title": data.get("title") if data.get("title") else None,
                "authors": data.get("authors") if isinstance(data.get("authors"), list) else [],
                "year": int(data["year"]) if data.get("year") else None,
                "doi": data.get("doi") if data.get("doi") and data["doi"] != "null" else None,
            }
            logger.info("metadata_extracted",
                        title=result["title"][:60] if result["title"] else None,
                        authors=len(result["authors"]),
                        year=result["year"])
            return result

    except Exception as e:
        logger.warn("metadata_extraction_failed", error=str(e))

    return {"title": None, "authors": [], "year": None, "doi": None}


def extract_metadata_sync(text: str) -> dict[str, object]:
    """Synchronous wrapper for use in Celery tasks."""
    return asyncio.run(extract_metadata(text))
