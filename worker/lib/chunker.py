"""Section-aware markdown chunking for academic papers.

Splits extracted markdown into chunks that respect section boundaries.
Academic papers have clear sections (abstract, introduction, methods,
findings, discussion) — chunking within these boundaries means personas
can be prompted to focus on specific claim types.
"""

import re

import structlog
import tiktoken

logger = structlog.get_logger(__name__)

# Common academic section headings (case insensitive)
SECTION_PATTERNS = [
    r"(?i)^#{1,3}\s*(abstract)",
    r"(?i)^#{1,3}\s*(introduction|background)",
    r"(?i)^#{1,3}\s*(literature\s+review|related\s+work|prior\s+work)",
    r"(?i)^#{1,3}\s*(method(?:s|ology)?|approach|experimental\s+(?:design|setup))",
    r"(?i)^#{1,3}\s*(result(?:s)?|finding(?:s)?|analysis)",
    r"(?i)^#{1,3}\s*(discussion)",
    r"(?i)^#{1,3}\s*(conclusion(?:s)?|summary)",
    r"(?i)^#{1,3}\s*(references|bibliography)",
    r"(?i)^#{1,3}\s*(appendix|appendices|supplementary)",
    # Generic heading fallback
    r"^#{1,3}\s+(.+)",
]

# Tokenizer for counting tokens
_enc: tiktoken.Encoding | None = None


def _get_encoder() -> tiktoken.Encoding:
    global _enc
    if _enc is None:
        _enc = tiktoken.encoding_for_model("gpt-3.5-turbo")
    return _enc


def _count_tokens(text: str) -> int:
    return len(_get_encoder().encode(text))


def _detect_sections(markdown: str) -> list[tuple[str, str]]:
    """Split markdown into (section_name, section_content) pairs."""
    lines = markdown.split("\n")
    sections: list[tuple[str, str]] = []
    current_section = "untitled"
    current_lines: list[str] = []

    for line in lines:
        matched = False
        for pattern in SECTION_PATTERNS:
            m = re.match(pattern, line.strip())
            if m:
                # Save previous section
                if current_lines:
                    content = "\n".join(current_lines).strip()
                    if content:
                        sections.append((current_section, content))
                current_section = m.group(1).strip().lower()
                current_lines = []
                matched = True
                break
        if not matched:
            current_lines.append(line)

    # Don't forget the last section
    if current_lines:
        content = "\n".join(current_lines).strip()
        if content:
            sections.append((current_section, content))

    return sections


def _split_by_tokens(text: str, section: str, max_tokens: int, start_index: int) -> list[dict[str, object]]:
    """Split a section's text into chunks respecting token limits.

    Tries to split on paragraph boundaries. Falls back to sentence
    boundaries, then hard token splits.
    """
    chunks: list[dict[str, object]] = []
    paragraphs = re.split(r"\n\s*\n", text)

    current_chunk: list[str] = []
    current_tokens = 0
    chunk_index = start_index

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        para_tokens = _count_tokens(para)

        # If single paragraph exceeds max, split by sentences
        if para_tokens > max_tokens:
            # Flush current
            if current_chunk:
                content = "\n\n".join(current_chunk)
                chunks.append({
                    "section": section,
                    "content": content,
                    "chunk_index": chunk_index,
                    "token_count": _count_tokens(content),
                })
                chunk_index += 1
                current_chunk = []
                current_tokens = 0

            # Split long paragraph by sentences
            sentences = re.split(r'(?<=[.!?])\s+', para)
            sent_chunk: list[str] = []
            sent_tokens = 0
            for sent in sentences:
                st = _count_tokens(sent)
                if sent_tokens + st > max_tokens and sent_chunk:
                    content = " ".join(sent_chunk)
                    chunks.append({
                        "section": section,
                        "content": content,
                        "chunk_index": chunk_index,
                        "token_count": _count_tokens(content),
                    })
                    chunk_index += 1
                    sent_chunk = []
                    sent_tokens = 0
                sent_chunk.append(sent)
                sent_tokens += st

            if sent_chunk:
                content = " ".join(sent_chunk)
                current_chunk = [content]
                current_tokens = _count_tokens(content)
            continue

        # Normal case: add paragraph to current chunk
        if current_tokens + para_tokens > max_tokens and current_chunk:
            content = "\n\n".join(current_chunk)
            chunks.append({
                "section": section,
                "content": content,
                "chunk_index": chunk_index,
                "token_count": _count_tokens(content),
            })
            chunk_index += 1
            current_chunk = []
            current_tokens = 0

        current_chunk.append(para)
        current_tokens += para_tokens

    # Flush remaining
    if current_chunk:
        content = "\n\n".join(current_chunk)
        chunks.append({
            "section": section,
            "content": content,
            "chunk_index": chunk_index,
            "token_count": _count_tokens(content),
        })

    return chunks


def chunk_markdown(markdown: str, max_tokens: int = 800) -> list[dict[str, object]]:
    """Split markdown into section-aware chunks.

    Returns list of dicts: {section, content, chunk_index, token_count}.

    If fewer than 3 sections detected, falls back to token-count-based
    splitting with 'untitled' section labels.
    """
    sections = _detect_sections(markdown)

    # Fallback: only treat as one un-titled blob when section detection found
    # NOTHING. A paper with even one detected header (e.g. just "Methods")
    # gives downstream personas more to work with than losing the label.
    # Previous threshold of <3 was over-aggressive and stripped structure
    # from short papers / preprints.
    if not sections:
        logger.warning("chunker_no_sections_detected", fallback="untitled")
        sections = [("untitled", markdown)]
    elif len(sections) < 3:
        logger.info("chunker_few_sections", count=len(sections))

    all_chunks: list[dict[str, object]] = []
    chunk_index = 0

    for section_name, section_content in sections:
        # Skip references/bibliography — not useful for discourse
        if section_name in ("references", "bibliography"):
            continue

        new_chunks = _split_by_tokens(section_content, section_name, max_tokens, chunk_index)
        all_chunks.extend(new_chunks)
        chunk_index += len(new_chunks)

    logger.info("chunking_complete", total_chunks=len(all_chunks),
                sections=len(sections))
    return all_chunks
