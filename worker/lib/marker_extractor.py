"""Marker-based PDF text extraction — primary extraction path.

Marker re-renders PDFs visually and reconstructs structured markdown,
handling two-column layouts, equations, tables, and figures correctly.

NOTE: marker-pdf requires PyTorch (~2GB). When not available, falls back
to PyMuPDF raw text extraction via pdf_extractor.extract_text_pymupdf().
"""

import structlog

logger = structlog.get_logger(__name__)

_MARKER_AVAILABLE = False
try:
    from marker.converters.pdf import PdfConverter
    from marker.models import create_model_dict
    _MARKER_AVAILABLE = True
except ImportError:
    pass


def is_available() -> bool:
    """Check if marker-pdf is installed and usable."""
    return _MARKER_AVAILABLE


def extract_with_marker(file_path: str) -> str:
    """Extract text from a PDF using Marker, returning structured markdown.

    Returns markdown string with section headings preserved.
    Raises RuntimeError if marker is not available.
    """
    if not _MARKER_AVAILABLE:
        raise RuntimeError("marker-pdf is not installed. Install with: pip install marker-pdf")

    logger.info("marker_extract_start", file_path=file_path)

    converter = PdfConverter(artifact_dict=create_model_dict())
    rendered = converter(file_path)
    markdown = rendered.markdown

    logger.info("marker_extract_complete", file_path=file_path, length=len(markdown))
    return markdown
