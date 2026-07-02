"""Shim — the implementation lives in ficino_shared.signed_url (R10 DUP-4).

Kept so existing `from signed_url import ...` sites don't churn.
"""
from ficino_shared.signed_url import (  # noqa: F401
    DEFAULT_TTL_SECONDS,
    sign_resource,
    verify_token,
)
