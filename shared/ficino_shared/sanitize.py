"""Prompt-injection defenses shared by api and worker (R10 DUP-3).

PDF-extracted chunks and user-authored text can contain role-marker strings
(`System:`, `Assistant:`, `Human:`), instruction-like patterns, and delimiter
collisions that let a hostile document reshape a persona's behavior.

This module wraps that content in hard delimiters and normalizes it so the
model treats it as data rather than instructions. Call `fence_untrusted()`
at every prompt interpolation site that includes content the user or a
third party controls.
"""

from __future__ import annotations

import re

# Maximum length any single fenced block can take in a prompt. Longer content
# is truncated with a clear marker. This is a backstop against prompt bombs,
# not a correctness constraint — callers already pick chunks deliberately.
_MAX_BLOCK_LEN = 8000

# Role markers we strip at the start of a line. Matches common chat-format
# leaks like "System:", "Assistant:", "Human:", and variants with leading
# whitespace or bold markdown.
_ROLE_MARKER_RE = re.compile(
    r"""^[\s>*_#-]*          # optional markdown / quote prefix
        (system|assistant|human|user|ai|instruction)   # role keyword
        [\s]*:[ \t]*""",
    re.IGNORECASE | re.MULTILINE | re.VERBOSE,
)

# Tokens that collide with our fence markers — if chunk content contains
# them, we need to escape/substitute before wrapping.
_FENCE_OPEN = "<untrusted>"
_FENCE_CLOSE = "</untrusted>"


def strip_role_markers(text: str) -> str:
    """Remove leading "System:", "Assistant:", "Human:"-style line prefixes.

    Unlike `fence_untrusted`, this returns plain text without the fence
    wrapper — intended for storage paths (e.g. the _parse_post_json fallback
    that persists raw LLM output into feeds.posts). Prompt-time callers
    should keep using `fence_untrusted` so the surrounding prompt can
    reference the `<untrusted>` region as data-only.
    """
    if not text:
        return ""
    return _ROLE_MARKER_RE.sub("", text)


def fence_untrusted(text: str, *, max_len: int = _MAX_BLOCK_LEN) -> str:
    """Wrap untrusted text in clear delimiters after stripping role markers.

    The returned string is safe to interpolate into an f-string prompt.
    Callers must explicitly include the `<untrusted>` / `</untrusted>` tags
    in the surrounding prompt text so the model treats this region as data.
    """
    if not text:
        return f"{_FENCE_OPEN}{_FENCE_CLOSE}"

    cleaned = strip_role_markers(text)
    # Neutralize any collision with our own fence markers.
    cleaned = cleaned.replace(_FENCE_OPEN, "&lt;untrusted&gt;")
    cleaned = cleaned.replace(_FENCE_CLOSE, "&lt;/untrusted&gt;")

    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len] + "… [truncated]"

    return f"{_FENCE_OPEN}{cleaned}{_FENCE_CLOSE}"


def sanitize_inline(text: object, *, max_len: int = 200) -> str:
    """Neutralize a short metadata field before inline prompt interpolation.

    `fence_untrusted` wraps a block in `<untrusted>…</untrusted>`, which works
    for multi-line content but is awkward for metadata fields like paper titles
    or section headings that appear inside a header line. This helper collapses
    whitespace (so a newline in the value can't escape the enclosing line),
    neutralizes our own fence tokens, strips role markers, and caps length.

    Use at every site where PDF-derived metadata (paper_title, section, cite,
    figure description) is interpolated into a prompt without being fenced as
    a standalone block.
    """
    if text is None:
        return ""
    s = str(text)
    s = strip_role_markers(s)
    s = s.replace(_FENCE_OPEN, "&lt;untrusted&gt;")
    s = s.replace(_FENCE_CLOSE, "&lt;/untrusted&gt;")
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) > max_len:
        s = s[:max_len] + "…"
    return s
