"""HMAC signed URLs for figure downloads (worker-side mirror of api/signed_url.py).

Kept identical to api/signed_url.py so both services derive the same key from
SIGNED_URL_KEY (or, as a fallback, the shared DATABASE_URL). The worker signs
figure URLs with a longer TTL (24h) when persisting them into feed posts so
they survive the normal browse window; the api signs with the short default
TTL (10m) when listing figures live.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import time

_SIGNING_KEY = os.getenv(
    "SIGNED_URL_KEY",
    hashlib.sha256(
        (os.getenv("DATABASE_URL", "") + "::ficino-figure-salt").encode()
    ).hexdigest(),
).encode()

DEFAULT_TTL_SECONDS = 600  # 10 minutes — matches api/signed_url.py


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
