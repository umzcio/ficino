"""Vision-model-based figure detection for scientific PDFs.

Replaces the legacy "grab every embedded bitmap" approach. For each page
of the PDF, we hand a rendered page image to a VLM and ask it to return
a typed, structured list of *actual figures* — charts, diagrams,
photographs that the paper is treating as data — while silently
ignoring UI glyphs, logos, page furniture, publisher marks, and
decorative bitmaps.

Why per-page VLM and not bitmap-then-filter:
  PDFs contain every kind of image. A size/entropy filter on raw
  bitmaps can't reliably tell a document-icon glyph from a real
  figure, and it can't tell a photograph from a scatter plot. A VLM
  that sees the whole page context can. It also gives us, for free,
  the caption text, the figure number, the first paragraph that cites
  the figure, and a type classification — all things the downstream
  post-generation needs for grounded, on-topic output.

Provider abstraction mirrors claude_client.py / embedder.py:
  CONTEXT-like envs:
    FIGURE_DETECT_PROVIDER = anthropic | ollama | none
    FIGURE_DETECT_ANTHROPIC_MODEL = claude-sonnet-4-6 (default)
    FIGURE_DETECT_OLLAMA_MODEL  = qwen2.5vl:latest or similar

The detector returns normalized coordinates (0.0–1.0) relative to the
page image, so the caller doesn't need to know the render DPI.
"""

import asyncio
import base64
import json
import re

import httpx
import structlog

from lib.event_loop import LoopRunner
from lib.settings import get_active, ollama_base_url

logger = structlog.get_logger(__name__)


# Authoritative list of figure_type values. Keep in sync with the DB CHECK
# (none currently — nullable enum kept in code) and the allowed_figure_types
# arrays seeded in add_typed_figures.sql. A detector returning an unknown
# type is coerced to "other".
FIGURE_TYPES = (
    "chart_bar", "chart_line", "chart_scatter", "chart_other",
    "diagram", "schematic", "flowchart", "algorithm",
    "photograph", "map", "micrograph", "anatomical",
    "table_image", "other",
)


def _get_detect_config() -> dict[str, str]:
    """Read figure-detector config from active settings / env."""
    return {
        "provider": get_active("figure_detect_provider", "FIGURE_DETECT_PROVIDER", "anthropic"),
        "ollama_base_url": ollama_base_url(),
        "ollama_model": get_active(
            "figure_detect_ollama_model", "FIGURE_DETECT_OLLAMA_MODEL", "qwen2.5vl:latest",
        ),
        "anthropic_model": get_active(
            "figure_detect_anthropic_model", "FIGURE_DETECT_ANTHROPIC_MODEL", "claude-sonnet-4-6",
        ),
        "anthropic_api_key": get_active("anthropic_api_key", "ANTHROPIC_API_KEY", ""),
    }


# Hard cap on image size sent to the VLM. Rendering at 200 DPI a Letter page
# comes out to ~1700×2200 px. Anthropic caps image edges at 8000px anyway and
# oversized images silently waste tokens. If a caller renders at higher DPI
# they should downscale before handing bytes to this module.
# (Kept documentation-only — we currently rasterize at 200 DPI in the caller,
# well under the cap.)


SYSTEM_PROMPT = (
    "You identify the scientific figures on one page of an academic "
    "paper. A scientific figure is something the paper treats as data or "
    "evidence: charts, plots, diagrams, schematics, flowcharts, "
    "algorithm blocks, photographs of study subjects or field sites, "
    "maps, micrographs, anatomical illustrations, or table-as-image. "
    "You IGNORE anything that is NOT a scientific figure: UI glyphs, "
    "publisher logos, running-header icons, page-number badges, "
    "branding marks, decorative drop-caps, Creative Commons / license "
    "badges, QR codes, navigation arrows, social-media icons, and "
    "institutional wordmarks. If a page contains no scientific figures, "
    "return an empty list. "
    "You return strict JSON only — no prose, no code fences, no commentary."
)


def _build_user_prompt(page_number: int, page_text: str) -> str:
    """Prompt for one page. page_text is the text layer for this page, used
    so the model can locate captions, figure numbers, and references in
    body paragraphs without guessing."""
    truncated_text = page_text[:8000]
    return (
        f"This is page {page_number} of a scientific paper. "
        f"The page's text layer, for your reference:\n\n"
        f"<page_text>\n{truncated_text}\n</page_text>\n\n"
        "Return a JSON object of the form:\n"
        "{\n"
        '  "figures": [\n'
        "    {\n"
        '      "bbox": [x0, y0, x1, y1],   // normalized 0.0-1.0, relative to the page image\n'
        '      "type": "chart_bar" | "chart_line" | "chart_scatter" | "chart_other" |\n'
        '              "diagram" | "schematic" | "flowchart" | "algorithm" |\n'
        '              "photograph" | "map" | "micrograph" | "anatomical" |\n'
        '              "table_image" | "other",\n'
        '      "caption": "Exact caption text, e.g. \\"Fig. 5. ...\\"",\n'
        '      "figure_number": "5" | "5a" | "S3" | "" (if caption carries no number),\n'
        '      "data_claim": "One sentence, taken from caption or surrounding text, describing what this figure is evidence of",\n'
        '      "referenced_paragraph": "The first paragraph on this page that cites this figure by number, or empty string",\n'
        '      "confidence": 0.0-1.0\n'
        "    }\n"
        "  ]\n"
        "}\n\n"
        "Rules:\n"
        "- Do not return icons, logos, UI glyphs, or branding marks.\n"
        "- bbox tightly frames the figure AND its caption if the caption is adjacent.\n"
        "- If a single figure has multiple panels labeled (a), (b), (c), return ONE entry whose bbox covers all panels.\n"
        "- Empty list is correct when the page has no scientific figures.\n"
        "- Output strict JSON, no markdown, no prose."
    )


def _coerce_type(raw: object) -> str:
    """Map a model-returned type string onto the authoritative enum."""
    s = str(raw).strip().lower()
    if s in FIGURE_TYPES:
        return s
    # Lenient aliases the model sometimes emits.
    aliases = {
        "chart": "chart_other", "plot": "chart_other", "graph": "chart_other",
        "bar_chart": "chart_bar", "line_chart": "chart_line", "scatter_plot": "chart_scatter",
        "scatterplot": "chart_scatter", "histogram": "chart_bar",
        "flow_chart": "flowchart", "block_diagram": "diagram",
        "pseudocode": "algorithm", "pseudo_code": "algorithm",
        "picture": "photograph", "image": "photograph",
        "table": "table_image",
    }
    if s in aliases:
        return aliases[s]
    logger.warning("figure_detect_unknown_type_coerced_to_other", got=s[:40])
    return "other"


def _sanitize_figure(raw: dict) -> dict | None:
    """Validate and normalize one raw figure dict from the model.

    Returns None when the dict is too malformed to salvage (missing bbox,
    bbox out of [0,1], etc.) so the caller can drop it rather than feed
    junk into the crop step.
    """
    bbox = raw.get("bbox")
    if not isinstance(bbox, list) or len(bbox) != 4:
        return None
    try:
        x0, y0, x1, y1 = (float(v) for v in bbox)
    except (TypeError, ValueError):
        return None
    # Clamp to unit square. Models sometimes overshoot by a hair.
    x0 = max(0.0, min(1.0, x0))
    y0 = max(0.0, min(1.0, y0))
    x1 = max(0.0, min(1.0, x1))
    y1 = max(0.0, min(1.0, y1))
    if x1 <= x0 or y1 <= y0:
        return None
    # Reject implausibly tiny detections — below ~5% of page area is almost
    # always a misfire (e.g. a page-number badge the model flagged).
    if (x1 - x0) * (y1 - y0) < 0.005:
        return None

    caption = str(raw.get("caption", ""))[:2000]
    figure_number = str(raw.get("figure_number", ""))[:40]
    data_claim = str(raw.get("data_claim", ""))[:1000]
    referenced_paragraph = str(raw.get("referenced_paragraph", ""))[:2000]

    try:
        confidence = float(raw.get("confidence", 0.5))
    except (TypeError, ValueError):
        confidence = 0.5
    confidence = max(0.0, min(1.0, confidence))

    return {
        "bbox": [x0, y0, x1, y1],
        "type": _coerce_type(raw.get("type")),
        "caption": caption,
        "figure_number": figure_number,
        "data_claim": data_claim,
        "referenced_paragraph": referenced_paragraph,
        "confidence": confidence,
    }


def _parse_response(text: str) -> list[dict]:
    """Pull a {"figures": [...]} object out of the model's response.

    Strict JSON preferred; markdown-wrapped JSON tolerated; anything else
    returns []. We never fall back to regex scraping — a malformed
    detector response means we couldn't confidently identify figures on
    this page, and pushing garbage downstream is worse than missing a
    figure.
    """
    candidates = [text.strip()]
    # Model sometimes wraps in ```json ... ``` even when told not to.
    fence_match = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence_match:
        candidates.append(fence_match.group(1).strip())

    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            continue
        figs = data.get("figures") if isinstance(data, dict) else None
        if not isinstance(figs, list):
            continue
        sanitized: list[dict] = []
        for raw in figs:
            if not isinstance(raw, dict):
                continue
            clean = _sanitize_figure(raw)
            if clean is not None:
                sanitized.append(clean)
        return sanitized

    logger.warning("figure_detect_response_unparseable", preview=text[:160])
    return []


async def _detect_anthropic(page_png: bytes, page_number: int, page_text: str) -> list[dict]:
    import anthropic

    cfg = _get_detect_config()
    client = anthropic.AsyncAnthropic(api_key=cfg["anthropic_api_key"])
    image_b64 = base64.b64encode(page_png).decode("utf-8")

    resp = await client.messages.create(
        model=cfg["anthropic_model"],
        max_tokens=2048,
        temperature=0.0,
        system=SYSTEM_PROMPT,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": "image/png", "data": image_b64},
                },
                {"type": "text", "text": _build_user_prompt(page_number, page_text)},
            ],
        }],
    )
    parts = [b.text for b in resp.content if getattr(b, "type", None) == "text"]
    return _parse_response("".join(parts))


async def _detect_ollama(page_png: bytes, page_number: int, page_text: str) -> list[dict]:
    cfg = _get_detect_config()
    image_b64 = base64.b64encode(page_png).decode("utf-8")

    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(
            f"{cfg['ollama_base_url']}/api/chat",
            json={
                "model": cfg["ollama_model"],
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": _build_user_prompt(page_number, page_text),
                        "images": [image_b64],
                    },
                ],
                "stream": False,
                "think": False,
                "options": {"temperature": 0.0},
            },
        )
        resp.raise_for_status()
        msg = resp.json()["message"]
        text = msg.get("content") or msg.get("thinking") or ""
    return _parse_response(text)


async def detect_figures_on_page(
    page_png: bytes, page_number: int, page_text: str,
) -> list[dict]:
    """Detect figures on one page. Returns a list of normalized, typed dicts.

    Never raises on provider error — logs and returns []. Figure detection
    is a quality upgrade; failing one page should not tank ingestion of a
    200-page paper.
    """
    cfg = _get_detect_config()
    provider = cfg["provider"]

    if provider == "none":
        return []

    try:
        if provider == "anthropic":
            if not cfg["anthropic_api_key"]:
                logger.error("figure_detect_no_anthropic_key")
                return []
            return await _detect_anthropic(page_png, page_number, page_text)
        if provider == "ollama":
            return await _detect_ollama(page_png, page_number, page_text)
        logger.warning("figure_detect_unknown_provider", provider=provider)
        return []
    except Exception as e:
        logger.warning("figure_detect_page_failed",
                    page=page_number, provider=provider, error=str(e)[:200])
        return []


async def detect_figures_for_paper(
    page_images: list[bytes], page_texts: list[str],
) -> list[list[dict]]:
    """Detect figures for every page, with bounded concurrency.

    page_images[i] is the PNG for page i (0-indexed). page_texts[i] is
    the text layer for the same page. Returns a list aligned with pages;
    each element is the list of figure dicts for that page (possibly empty).

    Parallelism is bounded both to protect Anthropic's rate limits and to
    avoid burying Ollama under a 200-concurrent vision-call stampede for
    long papers. Semaphore of 4 is conservative but keeps a 20-page paper
    under ~20s of wall clock on Sonnet.
    """
    if not page_images:
        return []
    assert len(page_images) == len(page_texts), (
        "page_images and page_texts must be aligned 1:1 per page"
    )

    sem = asyncio.Semaphore(4)

    async def one(i: int) -> list[dict]:
        async with sem:
            return await detect_figures_on_page(
                page_images[i], page_number=i + 1, page_text=page_texts[i],
            )

    return await asyncio.gather(*[one(i) for i in range(len(page_images))])


# Sync wrapper — shared background-loop helper (R10 DUP-5: LoopRunner),
# same pattern used by embedder / claude_client.
_runner = LoopRunner("figure-detect-loop")


def detect_figures_for_paper_sync(
    page_images: list[bytes], page_texts: list[str],
) -> list[list[dict]]:
    """Synchronous wrapper for use in Celery tasks."""
    return _runner.run(detect_figures_for_paper(page_images, page_texts))


def is_available() -> bool:
    cfg = _get_detect_config()
    if cfg["provider"] == "anthropic" and cfg["anthropic_api_key"]:
        return True
    if cfg["provider"] == "ollama" and cfg["ollama_model"]:
        return True
    return False
