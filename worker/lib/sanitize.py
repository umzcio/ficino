"""Sanitization helpers for untrusted content flowing into LLM prompts.

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


def fence_untrusted(text: str, *, max_len: int = _MAX_BLOCK_LEN) -> str:
    """Wrap untrusted text in clear delimiters after stripping role markers.

    The returned string is safe to interpolate into an f-string prompt.
    Callers must explicitly include the `<untrusted>` / `</untrusted>` tags
    in the surrounding prompt text so the model treats this region as data.
    """
    if not text:
        return f"{_FENCE_OPEN}{_FENCE_CLOSE}"

    cleaned = _ROLE_MARKER_RE.sub("", text)
    # Neutralize any collision with our own fence markers.
    cleaned = cleaned.replace(_FENCE_OPEN, "&lt;untrusted&gt;")
    cleaned = cleaned.replace(_FENCE_CLOSE, "&lt;/untrusted&gt;")

    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len] + "… [truncated]"

    return f"{_FENCE_OPEN}{cleaned}{_FENCE_CLOSE}"


def fence_lines(lines: list[str], *, max_len: int = _MAX_BLOCK_LEN) -> str:
    """Fence a list of lines as one block, preserving line structure."""
    return fence_untrusted("\n".join(lines), max_len=max_len)
