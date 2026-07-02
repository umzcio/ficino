"""Shim — the implementation lives in ficino_shared.sanitize (R10 DUP-3)."""
from ficino_shared.sanitize import (  # noqa: F401
    fence_lines,
    fence_untrusted,
    sanitize_inline,
    strip_role_markers,
)
