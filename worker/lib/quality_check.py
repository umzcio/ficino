"""Extraction quality assessment — routes between primary and Vision fallback.

Scans extracted text for gibberish indicators common in academic PDFs:
- Custom font subsets producing garbled symbols
- Scanned documents with no text layer
- Encoding artifacts from certain publishers (especially Elsevier)
"""

import re
import structlog

logger = structlog.get_logger(__name__)

# Characters that shouldn't dominate academic text
SYMBOL_PATTERN = re.compile(r'[^\w\s.,;:!?\-\'\"()\[\]{}/@#$%&*+=<>]', re.UNICODE)

# Common encoding artifacts
ENCODING_ARTIFACTS = re.compile(r'[\ufffd\x00-\x08\x0b\x0c\x0e-\x1f]')

# Minimum viable extraction length (chars)
MIN_TEXT_LENGTH = 200

# Maximum allowed symbol density (ratio of symbol chars to total)
MAX_SYMBOL_DENSITY = 0.15

# Minimum average word length for English academic text
MIN_AVG_WORD_LENGTH = 2.5

# Maximum average word length (gibberish often produces very long "words")
MAX_AVG_WORD_LENGTH = 20.0


def check_extraction_quality(text: str) -> tuple[bool, str]:
    """Check extracted text for gibberish indicators.

    Returns (is_good, reason). If is_good is False, the Vision fallback
    should be used instead.
    """
    if not text or not text.strip():
        return False, "empty_extraction"

    stripped = text.strip()

    # Check minimum length
    if len(stripped) < MIN_TEXT_LENGTH:
        logger.warning("quality_check_short", length=len(stripped))
        return False, f"too_short ({len(stripped)} chars)"

    # Check encoding artifacts
    artifact_count = len(ENCODING_ARTIFACTS.findall(stripped))
    if artifact_count > 10:
        logger.warning("quality_check_artifacts", count=artifact_count)
        return False, f"encoding_artifacts ({artifact_count} found)"

    # Check symbol density
    symbol_count = len(SYMBOL_PATTERN.findall(stripped))
    density = symbol_count / len(stripped) if stripped else 1.0
    if density > MAX_SYMBOL_DENSITY:
        logger.warning("quality_check_symbols", density=round(density, 3))
        return False, f"high_symbol_density ({density:.1%})"

    # Check word length distribution
    words = stripped.split()
    if words:
        avg_word_len = sum(len(w) for w in words) / len(words)
        if avg_word_len < MIN_AVG_WORD_LENGTH:
            logger.warning("quality_check_word_length", avg=round(avg_word_len, 2))
            return False, f"abnormal_word_length (avg {avg_word_len:.1f})"
        if avg_word_len > MAX_AVG_WORD_LENGTH:
            logger.warning("quality_check_word_length", avg=round(avg_word_len, 2))
            return False, f"abnormal_word_length (avg {avg_word_len:.1f})"

    # Check for repeated gibberish patterns (e.g., same char sequences)
    # Sample first 1000 chars
    sample = stripped[:1000]
    unique_trigrams = set()
    for i in range(len(sample) - 2):
        unique_trigrams.add(sample[i:i+3])
    trigram_ratio = len(unique_trigrams) / max(len(sample) - 2, 1)
    if trigram_ratio < 0.05:
        logger.warning("quality_check_repetitive", ratio=round(trigram_ratio, 3))
        return False, f"repetitive_content (trigram ratio {trigram_ratio:.3f})"

    logger.info("quality_check_passed", length=len(stripped), words=len(words))
    return True, "ok"
