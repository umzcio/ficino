"""PyMuPDF-based text extraction, figure extraction, and page rasterization.

Heading detection uses multiple signals:
- Font size relative to the document's body text size (not absolute thresholds)
- Bold flag from font metadata
- Line position (standalone short lines are more likely headings)
- Known academic section name patterns
"""

import io
import re
from collections import Counter
from typing import Iterable, Iterator

import fitz  # PyMuPDF
import structlog
from PIL import Image

logger = structlog.get_logger(__name__)

# Minimum image dimensions to consider as a figure (not icons/logos)
MIN_FIGURE_WIDTH = 100
MIN_FIGURE_HEIGHT = 100

# Known academic section heading patterns
HEADING_PATTERNS = re.compile(
    r"^(abstract|introduction|background|literature\s+review|related\s+work|"
    r"methods?|methodology|approach|materials?\s+and\s+methods?|"
    r"results?|findings?|analysis|"
    r"discussion|conclusion|conclusions|summary|"
    r"limitations?|future\s+work|implications?|"
    r"references?|bibliography|appendix|appendices|"
    r"acknowledgm?ents?|funding|declarations?|"
    r"supplementary|data\s+availability|ethics|"
    r"theoretical\s+framework|conceptual\s+framework|"
    r"research\s+design|study\s+design|participants?|"
    r"data\s+collection|data\s+analysis|procedure|"
    r"key\s+findings|main\s+findings|"
    r"recommendations?|policy\s+implications?)$",
    re.IGNORECASE,
)

# Numbered heading patterns (e.g., "1. Introduction", "2.1 Methods")
NUMBERED_HEADING = re.compile(r"^\d+\.?\d*\.?\s+\w")


def _is_bold_span(span: dict) -> bool:
    """Detect bold from both the flags bit AND the font name.

    Many academic PDFs use custom font subsets where the bold flag
    isn't set, but the font name contains 'Bold', '.B', '-Bold', etc.
    """
    if span["flags"] & (1 << 4):
        return True
    font = span.get("font", "")
    # Check for bold indicators in font name
    if any(b in font for b in (".B", "Bold", "-Bold", "bold", ".b", "-Bd", "Bd")):
        return True
    return False


def _analyze_font_stats(doc: fitz.Document) -> dict[str, float]:
    """Analyze the document to find the dominant body text font size."""
    size_chars: Counter[float] = Counter()

    for page_num in range(min(10, len(doc))):
        page = doc[page_num]
        blocks = page.get_text("dict")["blocks"]
        for block in blocks:
            if block["type"] != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text = span["text"].strip()
                    if not text:
                        continue
                    size = round(span["size"], 1)
                    size_chars[size] += len(text)

    # Body size = the font size with the most characters
    body_size = size_chars.most_common(1)[0][0] if size_chars else 10.0

    return {
        "body_size": body_size,
    }


def _is_heading(
    text: str,
    font_size: float,
    is_bold: bool,
    body_size: float,
    line_char_count: int,
) -> int:
    """Determine if a line is a heading and what level.

    Returns 0 (not a heading), 1 (h1), or 2 (h2).
    """
    stripped = text.strip()
    if not stripped:
        return 0

    # Very short lines that are ALL CAPS are likely headings
    is_allcaps = stripped.isupper() and len(stripped) > 2

    # Font size relative to body text
    size_ratio = font_size / body_size if body_size > 0 else 1.0
    is_larger = size_ratio >= 1.1

    # Check if it matches a known section heading pattern
    # Strip leading numbers like "1.", "2.1", etc.
    clean_text = re.sub(r"^\d+\.?\d*\.?\s*", "", stripped).strip()
    is_known_heading = bool(HEADING_PATTERNS.match(clean_text))
    is_numbered = bool(NUMBERED_HEADING.match(stripped))

    # Title-level heading: much larger font
    if size_ratio >= 1.5:
        return 1

    # Larger font + known heading pattern (even if not bold)
    if is_larger and is_known_heading:
        return 1

    # Larger font + short line = likely heading
    if is_larger and line_char_count < 80 and len(stripped.split()) <= 10:
        if is_known_heading:
            return 1
        if len(stripped.split()) >= 2:
            return 1 if size_ratio >= 1.3 else 2

    # Bold + known pattern (at any size)
    if is_bold and is_known_heading:
        return 1

    # Bold + numbered pattern (e.g., "1. Introduction")
    if is_bold and is_numbered:
        return 1 if size_ratio >= 1.0 else 2

    # Bold + short line + larger than body
    if is_bold and is_larger and line_char_count < 80:
        return 1

    # Bold + short standalone line (even at body size)
    if is_bold and line_char_count < 60:
        # Skip lines that are parenthetical, abbreviations, DOIs, or very short junk
        if re.match(r"^\(.*\)$", stripped):
            return 0
        if re.match(r"^[\d./:]+$", stripped):
            return 0
        if len(stripped) < 3:
            return 0

        # Known academic heading = always h1 (even single word like "Abstract")
        if is_known_heading:
            return 1

        # Unknown bold short line — needs 3+ words to qualify as h2
        # (avoids table cells, author names, short labels)
        if len(stripped.split()) >= 3 and line_char_count >= 10:
            return 2

    # ALL CAPS short line with 3+ words
    if is_allcaps and line_char_count < 60 and len(stripped.split()) >= 3:
        return 2

    return 0


def get_page_count(file_path: str) -> int:
    """Return the number of pages in a PDF."""
    doc = fitz.open(file_path)
    count = len(doc)
    doc.close()
    return count


def extract_pages_text(file_path: str) -> list[str]:
    """Extract plain text per page, one string per page.

    Used by the figure detector to locate captions / figure numbers /
    body-paragraph references for each page it's asked to classify. Plain
    `page.get_text()` is fine here — we don't need heading detection or
    markdown; the VLM sees the page image itself for layout.
    """
    doc = fitz.open(file_path)
    try:
        return [page.get_text() for page in doc]
    finally:
        doc.close()


def extract_text_pymupdf(file_path: str) -> str:
    """Extract text from PDF using PyMuPDF with improved heading detection.

    Uses font analysis to determine body text size, then detects headings
    via bold flags, font size ratios, and known academic section patterns.
    """
    logger.info("pymupdf_extract_start", file_path=file_path)
    doc = fitz.open(file_path)

    # Analyze font statistics first
    stats = _analyze_font_stats(doc)
    body_size = stats["body_size"]
    logger.info("pymupdf_font_analysis", body_size=body_size)

    pages: list[str] = []

    for page_num, page in enumerate(doc):
        blocks = page.get_text("dict")["blocks"]
        page_text_parts: list[str] = []

        for block in blocks:
            if block["type"] != 0:  # skip image blocks
                continue
            for line in block.get("lines", []):
                line_text = ""
                max_size = 0.0
                line_bold = False
                for span in line.get("spans", []):
                    line_text += span["text"]
                    max_size = max(max_size, span["size"])
                    if _is_bold_span(span):
                        line_bold = True

                text = line_text.strip()
                if not text:
                    continue

                heading_level = _is_heading(
                    text, max_size, line_bold, body_size, len(text)
                )

                if heading_level == 1:
                    page_text_parts.append(f"\n# {text}\n")
                elif heading_level == 2:
                    page_text_parts.append(f"\n## {text}\n")
                else:
                    page_text_parts.append(text)

        pages.append("\n".join(page_text_parts))

    doc.close()
    result = "\n\n".join(pages)
    logger.info("pymupdf_extract_complete", file_path=file_path, length=len(result))
    return result


# Per-paper cap on typed figures kept in storage. A crafted (or just
# long / figure-dense) PDF could ship hundreds of detector-qualified
# figures into downstream vision-description + storage writes, all
# billed to the paper owner. 50 is well above any real research paper
# (median ~6, p99 ~25) and saves both API budget and IDB cache bloat.
MAX_FIGURES_PER_PAPER = 50

# Padding to add around the VLM-returned bbox before cropping, as a
# fraction of page dimension. Claude's vision bboxes are often too tight
# — axis labels, panel letters (a)/(b)/(c), and the last line of caption
# text end up clipped at the edges. 4% on each side adds roughly 50 px
# at 150 dpi on US Letter, enough to catch axis labels + a caption line
# without bleeding into neighboring figures. Clamped to the page bounds
# in the crop itself so we never overshoot.
FIGURE_CROP_PADDING_RATIO = 0.04


def extract_figures(file_path: str) -> list[dict[str, object]]:
    """Detect and extract *typed* scientific figures via a vision model.

    Replaces the old "grab every embedded bitmap" approach, which pulled
    UI glyphs, publisher logos, and running-header icons alongside real
    figures and had no way to distinguish a scatter plot from a stock
    photograph. That indiscriminate output poisoned downstream
    persona-post generation (Methods Skeptic earnestly critiquing a doc
    icon, Stats Nerd trying to do statistics on a building photograph).

    New flow:
      1. Rasterize every page at ~150 DPI.
      2. Ask a VLM (Claude Sonnet by default) to return a typed list of
         scientific figures for each page — with caption, figure number,
         body-paragraph reference, type classification, and a normalized
         bbox. Non-scientific bitmaps are silently dropped at this step.
      3. Crop each detected bbox from the same raster the VLM saw.

    Each returned dict includes the crop as raw PNG bytes under
    `image_bytes` and a suggested `filename`. The caller is responsible
    for persisting the bytes via the storage adapter — this function
    never touches the filesystem so it works identically for local and
    cloud backends.
    """
    from lib import figure_detector

    logger.info("figure_extract_start", file_path=file_path)

    if not figure_detector.is_available():
        logger.warn("figure_detector_unavailable_skipping_figures")
        return []

    # Page rendering + per-page text for the detector. 150 DPI is the
    # sweet spot: high enough that Sonnet can read caption text and
    # axis labels, low enough that image-token cost stays predictable
    # (~2800 tokens/page for a Letter-sized rendering).
    page_count = get_page_count(file_path)
    page_pngs: list[bytes] = list(
        rasterize_pages(file_path, range(page_count), dpi=150),
    )
    page_texts = extract_pages_text(file_path)

    per_page = figure_detector.detect_figures_for_paper_sync(page_pngs, page_texts)

    figures: list[dict[str, object]] = []
    figure_index = 0

    for page_num, (page_png, detections) in enumerate(zip(page_pngs, per_page)):
        if not detections:
            continue
        # Open the rendered page once, crop all of its detected figures
        # from it. Crop bytes are returned to the caller for storage.
        page_img = Image.open(io.BytesIO(page_png))
        page_w, page_h = page_img.size

        for det in detections:
            x0n, y0n, x1n, y1n = det["bbox"]
            # Expand the VLM bbox by a small padding ratio before cropping.
            # The detector's bboxes are reliable for locating the figure
            # but frequently clip axis labels, panel-letter labels, and
            # the last caption line. Padding a few percent out on each
            # side recovers those edges; the clamp to [0,1] ensures we
            # never read past the page.
            pad = FIGURE_CROP_PADDING_RATIO
            px0 = max(0.0, x0n - pad)
            py0 = max(0.0, y0n - pad)
            px1 = min(1.0, x1n + pad)
            py1 = min(1.0, y1n + pad)
            crop_box = (
                int(px0 * page_w), int(py0 * page_h),
                int(px1 * page_w), int(py1 * page_h),
            )
            crop = page_img.crop(crop_box)
            if crop.mode not in ("RGB", "RGBA", "L", "1"):
                crop = crop.convert("RGBA" if "A" in crop.mode else "RGB")

            fig_filename = f"fig_p{page_num + 1}_{figure_index}.png"
            buf = io.BytesIO()
            crop.save(buf, "PNG")

            figures.append({
                "page": page_num + 1,
                "filename": fig_filename,
                "image_bytes": buf.getvalue(),
                "extraction_type": "vlm_detected",
                "width": crop.width,
                "height": crop.height,
                "figure_index": figure_index,
                # Typed metadata from the detector. These travel all the way
                # through to the DB via store_figure.
                "figure_type": det["type"],
                "caption": det["caption"],
                "figure_number": det["figure_number"],
                "data_claim": det["data_claim"],
                "referenced_paragraph": det["referenced_paragraph"],
                "bbox": {
                    "page": page_num + 1,
                    "x0": x0n, "y0": y0n, "x1": x1n, "y1": y1n,
                },
                "detector_confidence": det["confidence"],
            })
            figure_index += 1
            logger.info(
                "figure_extracted",
                page=page_num + 1, type=det["type"],
                figure_number=det["figure_number"] or "?",
                confidence=round(det["confidence"], 2),
                size=f"{crop.width}x{crop.height}",
            )

    if len(figures) > MAX_FIGURES_PER_PAPER:
        logger.warn(
            "figure_extract_capped",
            file_path=file_path,
            extracted=len(figures),
            cap=MAX_FIGURES_PER_PAPER,
        )
        figures = figures[:MAX_FIGURES_PER_PAPER]

    logger.info("figure_extract_complete", file_path=file_path, count=len(figures))
    return figures


def rasterize_pages(
    file_path: str, page_nums: Iterable[int], dpi: int = 300,
) -> Iterator[bytes]:
    """Rasterize multiple PDF pages, opening the document once.

    `fitz.open()` parses the whole PDF header + xref and allocates internal
    structures. Calling it once per page inside a vision-extraction loop
    (as rasterize_page used to be invoked) multiplies that parse cost by
    the page count — on long PDFs this is the dominant overhead before
    the vision API call itself. Yielding within a single open document
    keeps per-page work to `get_pixmap` + tobytes.
    """
    doc = fitz.open(file_path)
    try:
        zoom = dpi / 72.0
        mat = fitz.Matrix(zoom, zoom)
        for page_num in page_nums:
            page = doc[page_num]
            pix = page.get_pixmap(matrix=mat)
            yield pix.tobytes("png")
    finally:
        doc.close()
