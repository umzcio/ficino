"""HMAC signed URLs for figure downloads.

Shared by both the api and worker containers (R10 DUP-4) so they derive the
same signing key from SIGNED_URL_KEY (or, in development only, a fallback
derived from DATABASE_URL). The api signs with the short default TTL when
listing figures live; the worker signs with a much longer TTL when
persisting figure URLs into feed posts so they survive the normal browse
window (worker/tasks/persona_tasks.py uses a 30-day TTL there).

The signing key is derived from a dedicated env var so rotating it is a
deploy-time knob. Tokens carry (resource_id, expires_at) signed with HMAC-SHA256
and base64url-encoded. Verification is constant-time.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import time

from ficino_shared.constants import SIGNED_URL_DEFAULT_TTL as DEFAULT_TTL_SECONDS


def _resolve_signing_key() -> bytes:
    """Resolve the signing key; fail-closed in production if unset.

    The prior fallback derived a key from DATABASE_URL + a fixed salt. Since
    DATABASE_URL often holds a known default (`ficino:ficino@postgres`), the
    fallback was reproducible from the repo — forgeable figure tokens. In
    production we refuse to start rather than ship a derivable key.
    """
    key = os.getenv("SIGNED_URL_KEY", "").strip()
    if key:
        return key.encode()

    if os.getenv("ENVIRONMENT", "development") == "production":
        raise RuntimeError(
            "SIGNED_URL_KEY is required when ENVIRONMENT=production. "
            'Generate with: python -c "import secrets; print(secrets.token_hex(32))"'
        )

    # Dev only: derive a stable-per-machine key from DATABASE_URL.
    return hashlib.sha256(
        (os.getenv("DATABASE_URL", "") + "::ficino-figure-salt").encode()
    ).hexdigest().encode()


_SIGNING_KEY = _resolve_signing_key()


def sign_resource(resource_id: str, ttl: int = DEFAULT_TTL_SECONDS) -> str:
    """Return a URL-safe token authorizing access to `resource_id` for `ttl` seconds."""
    expires = int(time.time()) + ttl
    payload = f"{resource_id}:{expires}".encode()
    digest = hmac.new(_SIGNING_KEY, payload, hashlib.sha256).digest()
    b = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return f"{expires}.{b}"


def verify_token(resource_id: str, token: str) -> bool:
    """Return True if token is valid + not expired for this resource_id."""
    try:
        expires_str, digest_b64 = token.split(".", 1)
        expires = int(expires_str)
    except (ValueError, AttributeError):
        return False

    if expires < int(time.time()):
        return False

    payload = f"{resource_id}:{expires}".encode()
    expected = hmac.new(_SIGNING_KEY, payload, hashlib.sha256).digest()
    expected_b64 = base64.urlsafe_b64encode(expected).rstrip(b"=").decode()
    return hmac.compare_digest(digest_b64, expected_b64)
