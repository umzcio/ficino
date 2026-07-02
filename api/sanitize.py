"""Shim — the implementation lives in ficino_shared.sanitize (R10 DUP-3).

Kept so existing `from sanitize import ...` sites don't churn.
"""
from ficino_shared.sanitize import (  # noqa: F401
    _MAX_BLOCK_LEN,  # re-exported: api/tests/test_sanitize.py imports this
    fence_untrusted,
    sanitize_inline,
    strip_role_markers,
)
