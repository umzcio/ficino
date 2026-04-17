"""Sanitization helpers for untrusted content flowing into LLM prompts.

Duplicated intentionally from worker/lib/sanitize.py — the api and worker
containers are separate Python packages and can't share a module without
a shared volume or a `common/` package that both import. When updating
one, update the other.
"""

from __future__ import annotations

import re

_MAX_BLOCK_LEN = 8000

_ROLE_MARKER_RE = re.compile(
    r"""^[\s>*_#-]*
        (system|assistant|human|user|ai|instruction)
        [\s]*:[ \t]*""",
    re.IGNORECASE | re.MULTILINE | re.VERBOSE,
)

_FENCE_OPEN = "<untrusted>"
_FENCE_CLOSE = "</untrusted>"


def fence_untrusted(text: str, *, max_len: int = _MAX_BLOCK_LEN) -> str:
    """Wrap untrusted text in clear delimiters after stripping role markers."""
    if not text:
        return f"{_FENCE_OPEN}{_FENCE_CLOSE}"

    cleaned = _ROLE_MARKER_RE.sub("", text)
    cleaned = cleaned.replace(_FENCE_OPEN, "&lt;untrusted&gt;")
    cleaned = cleaned.replace(_FENCE_CLOSE, "&lt;/untrusted&gt;")

    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len] + "… [truncated]"

    return f"{_FENCE_OPEN}{cleaned}{_FENCE_CLOSE}"
