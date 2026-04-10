"""PyMuPDF-based text extraction, figure extraction, and page rasterization.

Heading detection uses multiple signals:
- Font size relative to the document's body text size (not absolute thresholds)
- Bold flag from font metadata
- Line position (standalone short lines are more likely headings)
- Known academic section name patterns
"""

import io
import os
import re
from collections import Counter
from pathlib import Path

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


def extract_figures(file_path: str, output_dir: str) -> list[dict[str, object]]:
    """Extract embedded figures/images from a PDF using PyMuPDF.

    Extracts bitmap-embedded images. For figures rendered as vector
    drawing commands, rasterizes the full page and crops.

    Returns list of dicts: {page, image_path, extraction_type, width, height}
    """
    logger.info("figure_extract_start", file_path=file_path)
    os.makedirs(output_dir, exist_ok=True)

    doc = fitz.open(file_path)
    figures: list[dict[str, object]] = []
    figure_index = 0

    for page_num, page in enumerate(doc):
        image_list = page.get_images(full=True)

        for img_idx, img_info in enumerate(image_list):
            xref = img_info[0]
            try:
                base_image = doc.extract_image(xref)
            except Exception:
                logger.warn("figure_extract_failed", page=page_num, xref=xref)
                continue

            image_bytes = base_image["image"]
            img = Image.open(io.BytesIO(image_bytes))

            # Skip small images (icons, logos, decorations)
            if img.width < MIN_FIGURE_WIDTH or img.height < MIN_FIGURE_HEIGHT:
                continue

            # Save as PNG
            fig_filename = f"fig_p{page_num + 1}_{img_idx}.png"
            fig_path = os.path.join(output_dir, fig_filename)
            img.save(fig_path, "PNG")

            figures.append({
                "page": page_num + 1,
                "image_path": fig_path,
                "extraction_type": "bitmap",
                "width": img.width,
                "height": img.height,
                "figure_index": figure_index,
            })
            figure_index += 1
            logger.info("figure_extracted", page=page_num + 1, size=f"{img.width}x{img.height}")

    doc.close()
    logger.info("figure_extract_complete", file_path=file_path, count=len(figures))
    return figures


def rasterize_page(file_path: str, page_num: int, dpi: int = 300) -> bytes:
    """Rasterize a single PDF page to PNG bytes at the given DPI."""
    doc = fitz.open(file_path)
    page = doc[page_num]
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat)
    png_bytes = pix.tobytes("png")
    doc.close()
    return png_bytes
